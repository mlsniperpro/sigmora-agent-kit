import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';

export const DEFAULT_API_BASE = 'https://api.sigmora.org';
export const SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024 * 1024;
export const MULTIPART_URL_BATCH_SIZE = 100;
export const MULTIPART_CONCURRENCY = 4;
export const RECOVERY_MAX_STEPS = 8;
export const DEFAULT_STORAGE_HOST_SUFFIXES = Object.freeze([
  'backblazeb2.com',
  'r2.cloudflarestorage.com',
]);

const CANONICAL_API_ORIGIN = new URL(DEFAULT_API_BASE).origin;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RECOVERY_ACTIONS = new Set(['upload_bytes', 'wait', 'retry_complete', 'restart_prepare', 'none']);

const MIME_TYPES = Object.freeze({
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
});

const INGEST_MIME_TYPES = new Set([
  ...Object.values(MIME_TYPES),
  'audio/webm',
  'audio/x-m4a',
]);

function extension(fileName) {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
}

export function inferMimeType(fileName) {
  return MIME_TYPES[extension(fileName)];
}

export function assertSafeFileName(fileName) {
  if (
    typeof fileName !== 'string'
    || fileName.length < 1
    || fileName.length > 255
    || fileName === '.'
    || fileName === '..'
    || /[\x00-\x1F\x7F/\\]/.test(fileName)
  ) {
    throw new Error('Upload file name must be a plain base name without dot paths or ASCII control characters.');
  }
  return fileName;
}

export function assertSecureUrl(value, label, { allowLocalhost = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS${allowLocalhost ? ' (HTTP is allowed only for localhost)' : ''}.`);
  }
  return url;
}

export function assertTrustedSigmoraOrigin(value, label, { allowCustomOrigin = false } = {}) {
  const url = assertSecureUrl(value, label, { allowLocalhost: allowCustomOrigin });
  if (url.origin !== CANONICAL_API_ORIGIN && !allowCustomOrigin) {
    throw new Error(`${label} is not the canonical Sigmora origin; pass --allow-custom-origin only after explicitly trusting it.`);
  }
  return url;
}

function normalizeStorageHost(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Storage allowlist entries must be host names.');
  const raw = value.trim().toLowerCase();
  if (raw.includes('://') || /[/\\?#@]/.test(raw) || raw.startsWith('.') || raw.endsWith('.')) {
    throw new Error(`Invalid storage allowlist host "${value}".`);
  }
  let parsed;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    throw new Error(`Invalid storage allowlist host "${value}".`);
  }
  if (parsed.hostname !== raw || parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password) {
    throw new Error(`Invalid storage allowlist host "${value}".`);
  }
  return parsed.hostname;
}

function storageHostAllowed(hostname, allowedSuffixes, allowLocalhost) {
  if (allowLocalhost && LOCAL_HOSTS.has(hostname)) return true;
  return allowedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function assertStorageUrl(value, label, { allowLocalhost, storageHosts }) {
  const url = assertSecureUrl(value, label, { allowLocalhost });
  if (!storageHostAllowed(url.hostname, storageHosts, allowLocalhost)) {
    throw new Error(`${label} host is not in the trusted storage allowlist.`);
  }
  return url;
}

function redact(value, apiKey) {
  let text = String(value ?? '');
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text
    .replace(/(https?:\/\/[^\s?#'"<>]+)\?[^\s#'"<>]*/gi, '$1?[REDACTED_QUERY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)_[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .slice(0, 500);
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function serverError(payload, fallback) {
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.error?.message === 'string') return payload.error.message;
  return fallback;
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function requestJson(url, {
  apiKey,
  body,
  idempotencyKey,
  fetchImpl,
  method = 'POST',
  retries,
  sleep = wait,
  signal,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          'User-Agent': 'sigmora-agent-kit/0.1.0',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal,
      });
      const payload = await responsePayload(response);
      if (response.ok && payload?.success !== false) return { payload, status: response.status };
      const message = redact(serverError(payload, `request failed with HTTP ${response.status}`), apiKey);
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      const sanitized = new Error(redact(error?.message || error, apiKey));
      sanitized.status = error?.status;
      sanitized.payload = error?.payload;
      lastError = sanitized;
      if (error?.status && error.status !== 429 && error.status < 500) throw sanitized;
    }
    if (attempt < retries) await sleep(Math.min(250 * (2 ** attempt), 2000));
  }
  throw lastError ?? new Error('Sigmora request failed.');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function assertSourceStable(source) {
  const descriptorStat = await source.handle.stat();
  if (!descriptorStat.isFile() || !sameSnapshot(source.snapshot, descriptorStat)) {
    throw new Error('The local file changed during upload; completion was not requested. Retry with the stable file.');
  }
  let currentParent;
  try {
    currentParent = await realpath(source.requestedParent);
  } catch {
    throw new Error('The upload source parent path changed during upload; completion was not requested.');
  }
  if (currentParent !== source.canonicalParent) {
    throw new Error('The upload source parent path changed during upload; completion was not requested.');
  }
  let requestedStat;
  let canonicalStat;
  try {
    requestedStat = await lstat(source.requestedPath);
    canonicalStat = await lstat(source.canonicalPath);
  } catch {
    throw new Error('The upload source path changed during upload; completion was not requested.');
  }
  if (
    requestedStat.isSymbolicLink()
    || canonicalStat.isSymbolicLink()
    || !requestedStat.isFile()
    || !canonicalStat.isFile()
    || !sameIdentity(source.snapshot, requestedStat)
    || !sameIdentity(source.snapshot, canonicalStat)
  ) {
    throw new Error('The upload source path changed during upload; completion was not requested.');
  }
}

async function openUploadSource(filePath) {
  const requestedPath = resolve(filePath);
  const requestedParent = dirname(requestedPath);
  const canonicalParent = await realpath(requestedParent);
  const canonicalPath = join(canonicalParent, basename(requestedPath));
  const requestedStat = await lstat(requestedPath);
  const canonicalStat = await lstat(canonicalPath);
  if (requestedStat.isSymbolicLink() || canonicalStat.isSymbolicLink()) {
    throw new Error('Refusing to upload a symbolic link; provide the resolved regular file explicitly.');
  }
  if (!requestedStat.isFile() || !canonicalStat.isFile() || !sameIdentity(requestedStat, canonicalStat)) {
    throw new Error('Upload source must be one stable regular file.');
  }

  let handle;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  try {
    try {
      handle = await open(canonicalPath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (!noFollow || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
      handle = await open(canonicalPath, fsConstants.O_RDONLY);
    }
    const snapshot = await handle.stat();
    if (!snapshot.isFile() || !sameIdentity(snapshot, canonicalStat)) {
      throw new Error('The upload source changed while it was being opened.');
    }
    const source = {
      handle,
      requestedPath,
      requestedParent,
      canonicalParent,
      canonicalPath,
      snapshot,
    };
    await assertSourceStable(source);
    return source;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function sourceReadStream(source, { start = 0, end = source.snapshot.size - 1 } = {}) {
  let position = start;
  let reading = false;
  return new Readable({
    read(requestedSize) {
      if (reading) return;
      const remaining = end - position + 1;
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      reading = true;
      const length = Math.min(Math.max(requestedSize, 16 * 1024), remaining);
      const buffer = Buffer.allocUnsafe(length);
      source.handle.read(buffer, 0, length, position).then(({ bytesRead }) => {
        reading = false;
        if (this.destroyed) return;
        if (!bytesRead) {
          this.push(null);
          return;
        }
        position += bytesRead;
        this.push(buffer.subarray(0, bytesRead));
      }, (error) => {
        reading = false;
        this.destroy(error);
      });
    },
  });
}

async function sha256Source(source, { onProgress } = {}) {
  const hash = createHash('sha256');
  let processed = 0;
  const stream = sourceReadStream(source);
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      processed += chunk.length;
      onProgress?.({ phase: 'hashing', transferredBytes: processed, totalBytes: source.snapshot.size });
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

export async function sha256File(filePath, { onProgress } = {}) {
  const source = await openUploadSource(filePath);
  try {
    const digest = await sha256Source(source, { onProgress });
    await assertSourceStable(source);
    return digest;
  } finally {
    await source.handle.close().catch(() => {});
  }
}

export function makeUploadIdempotencyKey({ projectId, fileName, sizeBytes, sha256 }) {
  const digest = createHash('sha256')
    .update('sigmora-agent-kit-upload-v1\0')
    .update(projectId)
    .update('\0')
    .update(fileName)
    .update('\0')
    .update(String(sizeBytes))
    .update('\0')
    .update(sha256)
    .digest('hex');
  return `sau_${digest}`;
}

function unwrap(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function normalizePrepare(payload, apiBase) {
  const data = unwrap(payload);
  const upload = data?.upload && typeof data.upload === 'object' ? data.upload : data;
  const uploadUrl = upload?.uploadUrl ?? upload?.url;
  const uploadId = upload?.uploadId ?? upload?.id ?? data?.uploadId;
  const contentId = upload?.contentId ?? data?.contentId ?? uploadId;
  if (typeof uploadId !== 'string' || !uploadId) throw new Error('Upload prepare response did not include uploadId/contentId.');
  if (typeof contentId !== 'string' || !contentId) throw new Error('Upload prepare response did not include contentId.');
  const method = upload?.method;
  if (!['PUT', 'MULTIPART'].includes(method)) throw new Error('Upload prepare response included an unsupported upload method.');
  if (method === 'PUT' && (typeof uploadUrl !== 'string' || !uploadUrl)) {
    throw new Error('Direct upload prepare response did not include upload.url.');
  }
  const uploadHeaders = upload?.uploadHeaders ?? upload?.headers ?? {};
  if (!uploadHeaders || typeof uploadHeaders !== 'object' || Array.isArray(uploadHeaders)) {
    throw new Error('Upload prepare response included invalid uploadHeaders.');
  }
  const partSize = upload?.partSize;
  if (method === 'MULTIPART' && (!Number.isSafeInteger(partSize) || partSize <= 0)) {
    throw new Error('Multipart prepare response did not include a valid partSize.');
  }
  const completion = data?.completeUrl ?? data?.completionUrl ?? upload?.completeUrl;
  const completeUrl = completion ? new URL(completion, apiBase).toString() : new URL('/v1/assets/upload/complete', apiBase).toString();
  return {
    method,
    lane: data?.lane ?? (method === 'PUT' ? 'single-put' : 'multipart'),
    uploadUrl,
    uploadHeaders,
    partSize,
    uploadId,
    contentId,
    projectId: data?.projectId,
    assetId: data?.assetId ?? data?.asset?.id ?? null,
    completeUrl,
    checksum: data?.checksum,
    expiresAt: upload?.expiresAt ?? data?.expiresAt,
    restart: data?.restart && typeof data.restart === 'object' ? data.restart : null,
  };
}

function safeUploadHeaders(input, { mimeType, sizeBytes }) {
  const headers = new Headers();
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = String(rawName).trim();
    const value = String(rawValue);
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new Error('Upload headers contained an invalid line break.');
    if (['authorization', 'cookie', 'proxy-authorization', 'x-api-key'].includes(name.toLowerCase())) {
      throw new Error(`Upload prepare response attempted to send credential header "${name}" to storage.`);
    }
    headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('Content-Type', mimeType);
  headers.set('Content-Length', String(sizeBytes));
  return headers;
}

function progressStream(source, totalBytes, onProgress, range = {}) {
  let transferred = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      onProgress?.({ phase: 'uploading', transferredBytes: transferred, totalBytes });
      callback(null, chunk);
    },
  });
  const fileStream = sourceReadStream(source, range);
  fileStream.on('error', (error) => meter.destroy(error));
  return { body: fileStream.pipe(meter), fileStream, meter };
}

async function putFile({ url, headers, source, sizeBytes, onProgress, fetchImpl, retries, sleep = wait, signal, apiKey }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const streams = progressStream(source, sizeBytes, onProgress);
    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers,
        body: streams.body,
        duplex: 'half',
        redirect: 'error',
        signal,
      });
      if (response.ok) return;
      const payload = await responsePayload(response);
      const error = new Error(redact(serverError(payload, `storage PUT failed with HTTP ${response.status}`), apiKey));
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = new Error(redact(error?.message || error, apiKey));
      if (error?.status && error.status !== 429 && error.status < 500) throw lastError;
    } finally {
      streams.meter.destroy();
      streams.fileStream.destroy();
    }
    if (attempt < retries) await sleep(Math.min(250 * (2 ** attempt), 2000));
  }
  throw lastError ?? new Error('Storage upload failed.');
}

function checksumValue(checksum) {
  if (typeof checksum === 'string') return checksum;
  if (checksum && typeof checksum === 'object') {
    return checksum.sha256 ?? (String(checksum.algorithm).toLowerCase() === 'sha256' ? checksum.value : undefined);
  }
  return undefined;
}

function assertPrepareBinding(prepared, { projectId, sha256 }) {
  if (prepared.projectId !== undefined && prepared.projectId !== projectId) {
    throw new Error('Upload prepare response was bound to a different project.');
  }
  const returnedChecksum = checksumValue(prepared.checksum);
  if (returnedChecksum !== undefined && String(returnedChecksum).toLowerCase() !== sha256) {
    throw new Error('Upload prepare response checksum did not match the local file.');
  }
}

function prepareExpired(prepared) {
  if (!prepared.expiresAt) return false;
  const expiry = Date.parse(prepared.expiresAt);
  return Number.isFinite(expiry) && expiry <= Date.now();
}

function normalizeParts(payload, requested) {
  const data = unwrap(payload);
  if (!Array.isArray(data?.parts)) throw new Error('Upload parts response did not include parts.');
  const byNumber = new Map();
  for (const part of data.parts) {
    if (!Number.isSafeInteger(part?.partNumber) || typeof part?.url !== 'string') {
      throw new Error('Upload parts response included an invalid part descriptor.');
    }
    if (byNumber.has(part.partNumber)) throw new Error('Upload parts response included a duplicate part number.');
    byNumber.set(part.partNumber, part.url);
  }
  return requested.map((partNumber) => {
    const url = byNumber.get(partNumber);
    if (!url) throw new Error(`Upload parts response omitted part ${partNumber}.`);
    return { partNumber, url };
  });
}

async function getMultipartParts({ apiUrl, apiKey, projectId, prepared, partCount, idempotencyKey, fetchImpl, retries, sleep, signal }) {
  const partsUrl = new URL('/v1/assets/upload/parts', apiUrl).toString();
  const descriptors = [];
  for (let first = 1; first <= partCount; first += MULTIPART_URL_BATCH_SIZE) {
    const partNumbers = Array.from(
      { length: Math.min(MULTIPART_URL_BATCH_SIZE, partCount - first + 1) },
      (_unused, index) => first + index,
    );
    const { payload } = await requestJson(partsUrl, {
      apiKey,
      idempotencyKey,
      fetchImpl,
      retries,
      sleep,
      signal,
      body: { projectId, uploadId: prepared.uploadId, contentId: prepared.contentId, partNumbers },
    });
    descriptors.push(...normalizeParts(payload, partNumbers));
  }
  return descriptors;
}

async function putPart({ descriptor, source, partSize, fileSize, fetchImpl, retries, sleep = wait, signal, apiKey, onBytes, allowLocalStorage, storageHosts }) {
  const start = (descriptor.partNumber - 1) * partSize;
  const end = Math.min(fileSize, start + partSize) - 1;
  const size = end - start + 1;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let attemptBytes = 0;
    onBytes(0, true);
    const streams = progressStream(source, size, (_event) => {
      attemptBytes = _event.transferredBytes;
      onBytes(attemptBytes, false);
    }, { start, end });
    try {
      const url = assertStorageUrl(descriptor.url, `Signed URL for part ${descriptor.partNumber}`, {
        allowLocalhost: allowLocalStorage,
        storageHosts,
      });
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Length': String(size) },
        body: streams.body,
        duplex: 'half',
        redirect: 'error',
        signal,
      });
      if (response.ok) {
        const etag = response.headers?.get?.('etag');
        if (!etag) throw new Error(`Storage response for part ${descriptor.partNumber} did not include an ETag.`);
        return { partNumber: descriptor.partNumber, etag };
      }
      const payload = await responsePayload(response);
      const error = new Error(redact(serverError(payload, `storage PUT for part ${descriptor.partNumber} failed with HTTP ${response.status}`), apiKey));
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = new Error(redact(error?.message || error, apiKey));
      if (error?.status && error.status !== 429 && error.status < 500) throw lastError;
    } finally {
      streams.meter.destroy();
      streams.fileStream.destroy();
    }
    if (attempt < retries) await sleep(Math.min(250 * (2 ** attempt), 2000));
  }
  throw lastError ?? new Error(`Storage upload for part ${descriptor.partNumber} failed.`);
}

async function uploadMultipart({ descriptors, source, partSize, fileSize, fetchImpl, retries, sleep, signal, apiKey, onProgress, allowLocalStorage, storageHosts }) {
  const receipts = new Array(descriptors.length);
  const progress = new Map();
  let next = 0;
  const report = (partNumber, bytes, reset) => {
    if (reset) progress.set(partNumber, 0);
    else progress.set(partNumber, bytes);
    const transferredBytes = [...progress.values()].reduce((sum, value) => sum + value, 0);
    onProgress?.({ phase: 'uploading', transferredBytes, totalBytes: fileSize, partNumber, partCount: descriptors.length });
  };
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= descriptors.length) return;
      const descriptor = descriptors[index];
      receipts[index] = await putPart({
        descriptor,
        source,
        partSize,
        fileSize,
        fetchImpl,
        retries,
        sleep,
        signal,
        apiKey,
        allowLocalStorage,
        storageHosts,
        onBytes: (bytes, reset) => report(descriptor.partNumber, bytes, reset),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MULTIPART_CONCURRENCY, descriptors.length) }, () => worker()));
  return receipts.sort((left, right) => left.partNumber - right.partNumber);
}

export function makeRestartIdempotencyKey({ previousIdempotencyKey, restartUploadId }) {
  const digest = createHash('sha256')
    .update('sigmora-agent-kit-upload-restart-v1\0')
    .update(previousIdempotencyKey)
    .update('\0')
    .update(restartUploadId)
    .digest('hex');
  return `saur_${digest}`;
}

export function makeCompletionIdempotencyKey({ baseIdempotencyKey, uploadId }) {
  const digest = createHash('sha256')
    .update('sigmora-agent-kit-upload-complete-v1\0')
    .update(baseIdempotencyKey)
    .update('\0')
    .update(uploadId)
    .digest('hex');
  return `sauc_${digest}`;
}

function normalizeStatus(payload, { projectId, uploadId, contentId }) {
  const data = unwrap(payload);
  if (!data || typeof data !== 'object') throw new Error('Upload status response was not an object.');
  if (data.projectId !== projectId) throw new Error('Upload status response was bound to a different project.');
  if (data.requestedUploadId !== uploadId) throw new Error('Upload status response did not echo the requested upload authority.');
  if (typeof data.uploadId !== 'string' || !data.uploadId) throw new Error('Upload status response did not include the current uploadId.');
  if (data.contentId !== contentId) throw new Error('Upload status response was bound to different content.');
  const nextAction = data.recovery?.nextAction;
  if (!RECOVERY_ACTIONS.has(nextAction)) throw new Error('Upload status response included an unsupported recovery action.');
  return { ...data, recovery: { ...data.recovery, nextAction } };
}

function authorityReference(data, apiUrl) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.uploadId !== 'string' || !data.uploadId || typeof data.contentId !== 'string' || !data.contentId) return null;
  return {
    method: undefined,
    lane: data.lane,
    uploadUrl: undefined,
    uploadHeaders: {},
    partSize: undefined,
    uploadId: data.uploadId,
    contentId: data.contentId,
    projectId: data.projectId,
    assetId: data.assetId ?? null,
    completeUrl: new URL('/v1/assets/upload/complete', apiUrl).toString(),
    checksum: data.checksum,
    expiresAt: data.expiresAt,
    recoveryPending: true,
  };
}

async function uploadStatus({ apiUrl, apiKey, projectId, uploadId, contentId, fetchImpl, retries, sleep, signal }) {
  const statusUrl = new URL('/v1/assets/upload/status', apiUrl);
  statusUrl.searchParams.set('projectId', projectId);
  statusUrl.searchParams.set('uploadId', uploadId);
  statusUrl.searchParams.set('contentId', contentId);
  const response = await requestJson(statusUrl, {
    apiKey,
    fetchImpl,
    method: 'GET',
    retries,
    sleep,
    signal,
  });
  return { ...response, normalized: normalizeStatus(response.payload, { projectId, uploadId, contentId }) };
}

function completedResult({ payload, projectId, attempt, fileName, mimeType, sizeBytes, sha256, recoveryPending = false }) {
  const completed = unwrap(payload) ?? {};
  const asset = completed.asset && typeof completed.asset === 'object' ? completed.asset : null;
  const content = completed.content && typeof completed.content === 'object' ? completed.content : null;
  return {
    projectId,
    uploadId: completed.uploadId ?? attempt.prepared.uploadId,
    contentId: completed.contentId ?? content?.id ?? attempt.prepared.contentId,
    assetId: completed.assetId ?? asset?.id ?? attempt.prepared.assetId,
    ingestStatus: completed.contentStatus
      ?? completed.ingestStatus
      ?? completed.state
      ?? completed.status
      ?? asset?.status
      ?? content?.status
      ?? (recoveryPending ? 'reconciling' : 'processing'),
    fileName,
    mimeType,
    sizeBytes,
    sha256,
    idempotencyKey: attempt.completionIdempotencyKey,
    lane: completed.lane ?? attempt.prepared.lane,
    ...(recoveryPending ? { recoveryPending: true, recoveryNextAction: completed.recovery?.nextAction ?? 'wait' } : {}),
  };
}

function definitiveCompletionError(error) {
  return [400, 401, 403, 404, 413].includes(error?.status);
}

export async function uploadFile({
  filePath,
  projectId,
  title,
  mimeType,
  apiBase = DEFAULT_API_BASE,
  allowCustomOrigin = false,
  storageHosts,
  apiKey,
  fetchImpl = globalThis.fetch,
  onProgress,
  retries = 2,
  sleep = wait,
  signal,
} = {}) {
  if (!filePath) throw new Error('A local file path is required.');
  if (!projectId || typeof projectId !== 'string') throw new Error('--project is required for every upload.');
  projectId = projectId.trim();
  if (!projectId || projectId.length > 200) throw new Error('--project must contain 1 to 200 non-whitespace characters.');
  if (!apiKey || typeof apiKey !== 'string') throw new Error('Set SIGMORA_API_KEY in the environment. API keys are not accepted as CLI arguments.');
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch. Node 20 or newer is required.');
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error('retries must be an integer from 0 to 5.');
  if (storageHosts !== undefined && !Array.isArray(storageHosts)) throw new Error('storageHosts must be an array of trusted host names.');

  const apiUrl = assertTrustedSigmoraOrigin(apiBase, 'Sigmora API base', { allowCustomOrigin });
  const allowLocalStorage = LOCAL_HOSTS.has(apiUrl.hostname);
  const trustedStorageHosts = [
    ...DEFAULT_STORAGE_HOST_SUFFIXES,
    ...(storageHosts ?? []).map(normalizeStorageHost),
  ];
  const source = await openUploadSource(filePath);
  try {
    if (source.snapshot.size <= 0) throw new Error('Upload source must not be empty.');
    if (source.snapshot.size > UPLOAD_MAX_BYTES) throw new Error('Uploads are capped at 50 GiB.');

    const fileName = assertSafeFileName(basename(source.requestedPath));
    const resolvedMime = mimeType || inferMimeType(fileName);
    if (!resolvedMime || !INGEST_MIME_TYPES.has(resolvedMime)) {
      throw new Error('Unsupported upload media type. Use a supported video, audio, or image file, or pass a supported --mime value.');
    }
    let resolvedTitle;
    if (title !== undefined) {
      if (typeof title !== 'string') throw new Error('--title must be a string.');
      resolvedTitle = title.trim();
      if (!resolvedTitle || resolvedTitle.length > 200) throw new Error('--title must contain 1 to 200 non-whitespace characters.');
    }

    const sizeBytes = source.snapshot.size;
    onProgress?.({ phase: 'hashing', transferredBytes: 0, totalBytes: sizeBytes });
    const sha256 = await sha256Source(source, { onProgress });
    await assertSourceStable(source);
    const baseIdempotencyKey = makeUploadIdempotencyKey({ projectId, fileName, sizeBytes, sha256 });
    const prepareUrl = new URL('/v1/assets/upload/prepare', apiUrl).toString();

    const prepare = async (idempotencyKey, restartUploadId) => {
      onProgress?.({ phase: 'preparing', transferredBytes: 0, totalBytes: sizeBytes });
      const response = await requestJson(prepareUrl, {
        apiKey,
        idempotencyKey,
        fetchImpl,
        retries,
        sleep,
        signal,
        body: {
          projectId,
          fileName,
          ...(resolvedTitle ? { title: resolvedTitle } : {}),
          mimeType: resolvedMime,
          sizeBytes,
          sha256,
          idempotencyKey,
          ...(restartUploadId ? { restartUploadId } : {}),
        },
      });
      const { payload } = response;
      if (response.status === 202) {
        const pending = authorityReference(unwrap(payload), apiUrl);
        if (!pending || pending.projectId !== projectId || !RECOVERY_ACTIONS.has(unwrap(payload)?.recovery?.nextAction)) {
          throw new Error('Pending upload prepare response did not include a safe recovery authority.');
        }
        return pending;
      }
      const prepared = normalizePrepare(payload, apiUrl);
      assertPrepareBinding(prepared, { projectId, sha256 });
      if (restartUploadId && prepared.restart?.previousUploadId !== restartUploadId) {
        throw new Error('Restart prepare response did not bind to the requested prior upload.');
      }
      return prepared;
    };

    let initialPrepared;
    let initialPrepareFailed = false;
    try {
      initialPrepared = await prepare(baseIdempotencyKey);
    } catch (error) {
      const failed = unwrap(error?.payload);
      const recoveryDetails = failed?.code === 'conflict' && failed.details && typeof failed.details === 'object'
        ? failed.details
        : failed;
      if (
        recoveryDetails?.projectId !== projectId
        || typeof recoveryDetails?.uploadId !== 'string'
        || !recoveryDetails.uploadId
        || typeof recoveryDetails?.contentId !== 'string'
        || !recoveryDetails.contentId
        || (failed?.code === 'conflict' && !RECOVERY_ACTIONS.has(recoveryDetails.nextAction))
      ) {
        throw error;
      }
      initialPrepareFailed = true;
      initialPrepared = authorityReference(recoveryDetails, apiUrl);
    }
    let attempt = {
      idempotencyKey: baseIdempotencyKey,
      prepared: initialPrepared,
      completionIdempotencyKey: null,
      parts: undefined,
      bytesUploaded: false,
      restartAncestor: null,
    };
    attempt.completionIdempotencyKey = makeCompletionIdempotencyKey({
      baseIdempotencyKey,
      uploadId: attempt.prepared.uploadId,
    });
    let action = initialPrepareFailed || attempt.prepared.recoveryPending || prepareExpired(attempt.prepared) ? 'status' : 'upload_bytes';
    let lastPayload = attempt.prepared;
    let lastStatus;
    let recoveryWaits = 0;
    let pendingCompletionError;

    const applyStatus = async () => {
      const queriedUploadId = attempt.prepared.uploadId;
      const statusResponse = await uploadStatus({
        apiUrl,
        apiKey,
        projectId,
        uploadId: queriedUploadId,
        contentId: attempt.prepared.contentId,
        fetchImpl,
        retries,
        sleep,
        signal,
      });
      const status = statusResponse.normalized;
      lastPayload = statusResponse.payload;
      lastStatus = status;
      if (status.uploadId !== queriedUploadId) {
        attempt.restartAncestor ??= status.requestedUploadId;
        attempt.idempotencyKey = makeRestartIdempotencyKey({
          previousIdempotencyKey: baseIdempotencyKey,
          restartUploadId: attempt.restartAncestor,
        });
        attempt.prepared = {
          ...attempt.prepared,
          method: undefined,
          uploadUrl: undefined,
          uploadHeaders: {},
          partSize: undefined,
          uploadId: status.uploadId,
          assetId: status.assetId ?? attempt.prepared.assetId,
          contentId: status.contentId,
          lane: status.lane ?? attempt.prepared.lane,
          expiresAt: status.expiresAt,
        };
        attempt.completionIdempotencyKey = makeCompletionIdempotencyKey({
          baseIdempotencyKey,
          uploadId: status.uploadId,
        });
      }
      const nextAction = status.recovery.nextAction;
      if (pendingCompletionError && definitiveCompletionError(pendingCompletionError) && !['none', 'wait'].includes(nextAction)) {
        throw pendingCompletionError;
      }
      if (!['wait', 'none'].includes(nextAction)) pendingCompletionError = undefined;
      return nextAction;
    };

    for (let step = 0; step < RECOVERY_MAX_STEPS; step += 1) {
      await assertSourceStable(source);
      if (action === 'status') {
        action = await applyStatus();
        continue;
      }
      if (action === 'wait') {
        await sleep(Math.min(250 * (2 ** recoveryWaits), 2000));
        recoveryWaits += 1;
        action = 'status';
        continue;
      }
      if (action === 'restart_prepare') {
        const restartUploadId = attempt.prepared.uploadId;
        const restartKey = makeRestartIdempotencyKey({
          previousIdempotencyKey: attempt.idempotencyKey,
          restartUploadId,
        });
        attempt.restartAncestor = restartUploadId;
        attempt.idempotencyKey = restartKey;
        try {
          attempt.prepared = await prepare(restartKey, restartUploadId);
        } catch (error) {
          if (!error?.status) {
            action = 'status';
            continue;
          }
          throw error;
        }
        attempt.parts = undefined;
        attempt.bytesUploaded = false;
        attempt.completionIdempotencyKey = makeCompletionIdempotencyKey({
          baseIdempotencyKey,
          uploadId: attempt.prepared.uploadId,
        });
        action = attempt.prepared.recoveryPending || prepareExpired(attempt.prepared) ? 'status' : 'upload_bytes';
        continue;
      }
      if (action === 'upload_bytes') {
        if (!attempt.prepared.uploadUrl && !attempt.prepared.partSize) {
          attempt.prepared = await prepare(attempt.idempotencyKey, attempt.restartAncestor ?? undefined);
          attempt.completionIdempotencyKey = makeCompletionIdempotencyKey({
            baseIdempotencyKey,
            uploadId: attempt.prepared.uploadId,
          });
          if (attempt.prepared.recoveryPending) {
            action = 'status';
            continue;
          }
        }
        const completeUrl = assertSecureUrl(attempt.prepared.completeUrl, 'Upload completion URL', { allowLocalhost: allowLocalStorage });
        if (completeUrl.origin !== apiUrl.origin) throw new Error('Upload completion URL must remain on the configured Sigmora API origin.');
        if (attempt.prepared.method === 'PUT') {
          if (sizeBytes > SINGLE_PUT_MAX_BYTES) throw new Error('Server selected a single PUT for a file larger than the 5 GiB direct-upload limit.');
          const storageUrl = assertStorageUrl(attempt.prepared.uploadUrl, 'Signed upload URL', {
            allowLocalhost: allowLocalStorage,
            storageHosts: trustedStorageHosts,
          });
          const uploadHeaders = safeUploadHeaders(attempt.prepared.uploadHeaders, { mimeType: resolvedMime, sizeBytes });
          await putFile({
            url: storageUrl,
            headers: uploadHeaders,
            source,
            sizeBytes,
            onProgress,
            fetchImpl,
            retries,
            sleep,
            signal,
            apiKey,
          });
          attempt.parts = undefined;
        } else {
          const partCount = Math.ceil(sizeBytes / attempt.prepared.partSize);
          if (!Number.isSafeInteger(partCount) || partCount <= 0 || partCount > 10_000) {
            throw new Error('Multipart prepare response would require an unsafe number of parts.');
          }
          const descriptors = await getMultipartParts({
            apiUrl,
            apiKey,
            projectId,
            prepared: attempt.prepared,
            partCount,
            idempotencyKey: attempt.idempotencyKey,
            fetchImpl,
            retries,
            sleep,
            signal,
          });
          attempt.parts = await uploadMultipart({
            descriptors,
            source,
            partSize: attempt.prepared.partSize,
            fileSize: sizeBytes,
            fetchImpl,
            retries,
            sleep,
            signal,
            apiKey,
            onProgress,
            allowLocalStorage,
            storageHosts: trustedStorageHosts,
          });
        }
        attempt.bytesUploaded = true;
        await assertSourceStable(source);
        action = 'retry_complete';
        continue;
      }
      if (action === 'retry_complete') {
        const completeUrl = assertSecureUrl(attempt.prepared.completeUrl, 'Upload completion URL', { allowLocalhost: allowLocalStorage });
        if (completeUrl.origin !== apiUrl.origin) throw new Error('Upload completion URL must remain on the configured Sigmora API origin.');
        onProgress?.({ phase: 'completing', transferredBytes: sizeBytes, totalBytes: sizeBytes });
        let completion;
        try {
          completion = await requestJson(completeUrl, {
            apiKey,
            idempotencyKey: attempt.completionIdempotencyKey,
            fetchImpl,
            retries,
            sleep,
            signal,
            body: {
              projectId,
              uploadId: attempt.prepared.uploadId,
              contentId: attempt.prepared.contentId,
              sizeBytes,
              sha256,
              idempotencyKey: attempt.completionIdempotencyKey,
              ...(attempt.parts ? { parts: attempt.parts } : {}),
            },
          });
        } catch (error) {
          pendingCompletionError = error;
          action = 'status';
          continue;
        }
        lastPayload = completion.payload;
        const completionData = unwrap(completion.payload);
        const completionAction = completionData?.recovery?.nextAction;
        if (completion.status === 202) {
          action = RECOVERY_ACTIONS.has(completionAction) ? completionAction : 'status';
          continue;
        }
        if (RECOVERY_ACTIONS.has(completionAction) && completionAction !== 'none') {
          action = completionAction;
          continue;
        }
        const result = completedResult({
          payload: completion.payload,
          projectId,
          attempt,
          fileName,
          mimeType: resolvedMime,
          sizeBytes,
          sha256,
        });
        onProgress?.({ phase: 'complete', transferredBytes: sizeBytes, totalBytes: sizeBytes });
        return result;
      }
      if (action === 'none') {
        // `none` only means there is nothing left to do. The server also
        // answers it when it settles the session as failed (its stored
        // content is missing or deleted), which is not an upload.
        if (lastStatus?.state !== 'completed') {
          const contentStatus = lastStatus?.contentStatus ?? 'unknown';
          throw new Error(
            `Sigmora reports this upload failed (state=${lastStatus?.state ?? 'unknown'}, content=${contentStatus}); `
            + 'no stored file backs it and it cannot be resumed.',
          );
        }
        const result = completedResult({
          payload: lastPayload,
          projectId,
          attempt,
          fileName,
          mimeType: resolvedMime,
          sizeBytes,
          sha256,
        });
        onProgress?.({ phase: 'complete', transferredBytes: sizeBytes, totalBytes: sizeBytes });
        return result;
      }
      throw new Error(`Unsupported upload recovery action "${action}".`);
    }

    if (lastStatus?.recovery?.nextAction === 'wait' || lastStatus?.state === 'finalizing') {
      return completedResult({
        payload: lastPayload,
        projectId,
        attempt,
        fileName,
        mimeType: resolvedMime,
        sizeBytes,
        sha256,
        recoveryPending: true,
      });
    }
    throw new Error('Upload recovery did not reach a safe terminal state within the bounded retry window.');
  } catch (error) {
    const sanitized = new Error(redact(error?.message || error, apiKey));
    throw sanitized;
  } finally {
    await source.handle.close().catch(() => {});
  }
}
