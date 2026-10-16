import assert from 'node:assert/strict';
import { symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertSafeFileName,
  makeCompletionIdempotencyKey,
  makeRestartIdempotencyKey,
  makeUploadIdempotencyKey,
  uploadFile,
} from '../lib/upload.js';

const TEST_STORAGE_HOSTS = ['storage.example'];

function testUpload(options) {
  return uploadFile({ storageHosts: TEST_STORAGE_HOSTS, ...options });
}

async function fixture(t, content = Buffer.from('hello-media')) {
  const root = await mkdtemp(join(tmpdir(), 'sigmora-upload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'clip.mp4');
  await writeFile(path, content);
  return { root, path, content };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function consume(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('direct upload reads the full pinned descriptor, uses exact bodies, and scopes idempotency per operation', async (t) => {
  const { path, content } = await fixture(t);
  const calls = [];
  let prepareBody;
  let putBody;
  let completeBody;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, redirect: options.redirect });
    if (String(url).endsWith('/v1/assets/upload/prepare')) {
      prepareBody = JSON.parse(options.body);
      return jsonResponse({
        uploadId: 'upl_1', projectId: 'prj_1', assetId: 'ast_1', contentId: 'cnt_1', lane: 'single-put',
        directBytesRequired: true, expiresAt: '2099-01-01T00:00:00.000Z', checksum: prepareBody.sha256,
        upload: { method: 'PUT', url: 'https://storage.example/upload-1', headers: { 'X-Signed': 'yes' }, expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    }
    if (String(url) === 'https://storage.example/upload-1') {
      putBody = await consume(options.body);
      assert.equal(options.headers.get('Authorization'), null);
      assert.equal(options.headers.get('X-Signed'), 'yes');
      return new Response(null, { status: 200, headers: { ETag: 'direct-etag' } });
    }
    if (String(url).endsWith('/v1/assets/upload/complete')) {
      completeBody = JSON.parse(options.body);
      return jsonResponse({ projectId: 'prj_1', assetId: 'ast_1', contentId: 'cnt_1', status: 'ready' });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const progress = [];
  const result = await testUpload({
    filePath: path,
    projectId: 'prj_1',
    apiKey: 'sigmora-secret',
    fetchImpl,
    retries: 0,
    onProgress: (event) => progress.push(event.phase),
  });

  assert.deepEqual(putBody, content);
  assert.notEqual(prepareBody.idempotencyKey, completeBody.idempotencyKey);
  assert.deepEqual(Object.keys(prepareBody).sort(), ['fileName', 'idempotencyKey', 'mimeType', 'projectId', 'sha256', 'sizeBytes']);
  assert.deepEqual(Object.keys(completeBody).sort(), ['contentId', 'idempotencyKey', 'projectId', 'sha256', 'sizeBytes', 'uploadId']);
  assert.equal(calls[0].headers['Idempotency-Key'], prepareBody.idempotencyKey);
  assert.equal(calls[2].headers['Idempotency-Key'], completeBody.idempotencyKey);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[2].redirect, 'error');
  assert.equal(completeBody.uploadId, 'upl_1');
  assert.equal(completeBody.contentId, 'cnt_1');
  assert.equal(completeBody.parts, undefined);
  assert.equal(result.assetId, 'ast_1');
  assert.equal(result.ingestStatus, 'ready');
  assert.equal(result.lane, 'single-put');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(progress.includes('hashing'));
  assert.equal(progress.at(-1), 'complete');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/v1/assets/upload/prepare', '/upload-1', '/v1/assets/upload/complete']);
});

test('same file and project derive the same idempotency key', () => {
  const input = { projectId: 'prj_same', fileName: 'clip.mp4', sizeBytes: 123, sha256: 'a'.repeat(64) };
  assert.equal(makeUploadIdempotencyKey(input), makeUploadIdempotencyKey({ ...input }));
  assert.notEqual(makeUploadIdempotencyKey(input), makeUploadIdempotencyKey({ ...input, projectId: 'prj_other' }));
  const restart = makeRestartIdempotencyKey({ previousIdempotencyKey: 'prepare-key', restartUploadId: 'upl_old' });
  assert.equal(restart, makeRestartIdempotencyKey({ previousIdempotencyKey: 'prepare-key', restartUploadId: 'upl_old' }));
  assert.notEqual(restart, 'prepare-key');
  const completion = makeCompletionIdempotencyKey({ baseIdempotencyKey: 'prepare-key', uploadId: 'upl_new' });
  assert.equal(completion, makeCompletionIdempotencyKey({ baseIdempotencyKey: 'prepare-key', uploadId: 'upl_new' }));
  assert.notEqual(completion, restart);
});

test('multipart upload requests bounded URLs, uploads ranges, and completes ordered ETags', async (t) => {
  const { path, content } = await fixture(t, Buffer.from('abcdefghij'));
  let requestedParts;
  let completeBody;
  const uploaded = new Map();
  const fetchImpl = async (url, options) => {
    const href = String(url);
    if (href.endsWith('/v1/assets/upload/prepare')) {
      const body = JSON.parse(options.body);
      return jsonResponse({
        uploadId: 'upl_multi', projectId: 'prj_1', assetId: 'ast_multi', contentId: 'cnt_multi', lane: 'multipart',
        directBytesRequired: true, checksum: body.sha256, expiresAt: '2099-01-01T00:00:00.000Z',
        upload: { method: 'MULTIPART', partSize: 4 },
      });
    }
    if (href.endsWith('/v1/assets/upload/parts')) {
      const body = JSON.parse(options.body);
      requestedParts = body.partNumbers;
      return jsonResponse({ parts: body.partNumbers.map((partNumber) => ({ partNumber, url: `https://storage.example/part-${partNumber}` })) });
    }
    if (href.startsWith('https://storage.example/part-')) {
      const partNumber = Number(href.split('-').at(-1));
      uploaded.set(partNumber, await consume(options.body));
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });
    }
    if (href.endsWith('/v1/assets/upload/complete')) {
      completeBody = JSON.parse(options.body);
      return jsonResponse({ assetId: 'ast_multi', contentId: 'cnt_multi', ingestStatus: 'processing' });
    }
    throw new Error(`unexpected URL ${href}`);
  };

  const result = await testUpload({ filePath: path, projectId: 'prj_1', apiKey: 'sigmora-secret', fetchImpl, retries: 0 });
  assert.deepEqual(requestedParts, [1, 2, 3]);
  assert.deepEqual(uploaded.get(1), content.subarray(0, 4));
  assert.deepEqual(uploaded.get(2), content.subarray(4, 8));
  assert.deepEqual(uploaded.get(3), content.subarray(8));
  assert.deepEqual(completeBody.parts, [
    { partNumber: 1, etag: '"etag-1"' },
    { partNumber: 2, etag: '"etag-2"' },
    { partNumber: 3, etag: '"etag-3"' },
  ]);
  assert.deepEqual(Object.keys(completeBody).sort(), ['contentId', 'idempotencyKey', 'parts', 'projectId', 'sha256', 'sizeBytes', 'uploadId']);
  assert.equal(result.lane, 'multipart');
});

test('multipart URL requests are split into batches of at most 100', async (t) => {
  const { path } = await fixture(t, Buffer.alloc(101, 7));
  const batches = [];
  const fetchImpl = async (url, options) => {
    const href = String(url);
    if (href.endsWith('/v1/assets/upload/prepare')) {
      const body = JSON.parse(options.body);
      return jsonResponse({ uploadId: 'upl_many', projectId: 'prj_1', contentId: 'cnt_many', lane: 'multipart', checksum: body.sha256, upload: { method: 'MULTIPART', partSize: 1 } });
    }
    if (href.endsWith('/v1/assets/upload/parts')) {
      const body = JSON.parse(options.body);
      batches.push(body.partNumbers);
      return jsonResponse({ parts: body.partNumbers.map((partNumber) => ({ partNumber, url: `https://storage.example/p/${partNumber}` })) });
    }
    if (href.startsWith('https://storage.example/p/')) {
      await consume(options.body);
      const partNumber = href.split('/').at(-1);
      return new Response(null, { status: 200, headers: { ETag: `etag-${partNumber}` } });
    }
    if (href.endsWith('/v1/assets/upload/complete')) return jsonResponse({ contentId: 'cnt_many', status: 'processing' });
    throw new Error(`unexpected URL ${href}`);
  };
  await testUpload({ filePath: path, projectId: 'prj_1', apiKey: 'sigmora-secret', fetchImpl, retries: 0 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 100);
  assert.deepEqual(batches[1], [101]);
});

test('storage PUT never receives the Sigmora bearer key', async (t) => {
  const { path } = await fixture(t);
  const key = 'sigmora-do-not-leak';
  const fetchImpl = async (url, options) => {
    const href = String(url);
    if (href.endsWith('/prepare')) {
      const body = JSON.parse(options.body);
      return jsonResponse({ uploadId: 'upl', projectId: 'prj', contentId: 'cnt', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/file', headers: {} } });
    }
    if (href === 'https://storage.example/file') {
      assert.doesNotMatch(JSON.stringify(Object.fromEntries(options.headers.entries())), new RegExp(key));
      await consume(options.body);
      return new Response(null, { status: 200 });
    }
    if (href.endsWith('/complete')) return jsonResponse({ contentId: 'cnt' });
    throw new Error('unexpected');
  };
  await testUpload({ filePath: path, projectId: 'prj', apiKey: key, fetchImpl, retries: 0 });
});

test('upload rejects credential-bearing storage headers and cross-origin completion', async (t) => {
  const { path } = await fixture(t);
  const prepared = (body, overrides = {}) => {
    const { upload: uploadOverrides = {}, ...responseOverrides } = overrides;
    return {
      uploadId: 'upl', projectId: 'prj', contentId: 'cnt', checksum: body.sha256, lane: 'single-put',
      upload: { method: 'PUT', url: 'https://storage.example/file', headers: {}, ...uploadOverrides },
      ...responseOverrides,
    };
  };
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'secret', retries: 0,
    fetchImpl: async (_url, options) => jsonResponse(prepared(JSON.parse(options.body), { upload: { headers: { Authorization: 'Bearer storage-secret' } } })),
  }), /credential header/);
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'secret', retries: 0,
    fetchImpl: async (_url, options) => jsonResponse(prepared(JSON.parse(options.body), { completeUrl: 'https://evil.example/complete' })),
  }), /configured Sigmora API origin/);
});

test('upload rejects symlinks, missing project, missing key, and insecure remote API URLs', async (t) => {
  const { root, path } = await fixture(t);
  const link = join(root, 'linked.mp4');
  await symlink(path, link);
  await assert.rejects(uploadFile({ filePath: link, projectId: 'prj', apiKey: 'key' }), /symbolic link/);
  await assert.rejects(uploadFile({ filePath: path, apiKey: 'key' }), /--project/);
  await assert.rejects(uploadFile({ filePath: path, projectId: 'prj' }), /SIGMORA_API_KEY/);
  await assert.rejects(uploadFile({ filePath: path, projectId: 'prj', apiKey: 'key', apiBase: 'http://remote.example' }), /must use HTTPS/);
});

test('upload rejects dot names, ASCII controls, long names, and unsupported media types', async (t) => {
  assert.throws(() => assertSafeFileName('.'), /plain base name/);
  assert.throws(() => assertSafeFileName('..'), /plain base name/);
  assert.throws(() => assertSafeFileName('bad\tname.mp4'), /ASCII control/);
  assert.throws(() => assertSafeFileName(`a${String.fromCharCode(127)}.mp4`), /ASCII control/);
  assert.throws(() => assertSafeFileName(`${'a'.repeat(252)}.mp4`), /plain base name/);

  const root = await fixture(t).then((value) => value.root);
  const badPath = join(root, 'bad\nname.mp4');
  await writeFile(badPath, 'media');
  await assert.rejects(uploadFile({ filePath: badPath, projectId: 'prj', apiKey: 'key' }), /ASCII control/);

  const unknownPath = join(root, 'clip.bin');
  await writeFile(unknownPath, 'media');
  await assert.rejects(uploadFile({ filePath: unknownPath, projectId: 'prj', apiKey: 'key' }), /Unsupported upload media type/);
});

test('network errors redact the Sigmora API key', async (t) => {
  const { path } = await fixture(t);
  const key = 'highly-sensitive-sigmora-key';
  await assert.rejects(
    uploadFile({ filePath: path, projectId: 'prj', apiKey: key, retries: 0, fetchImpl: async () => { throw new Error(`failure ${key}`); } }),
    (error) => !error.message.includes(key) && error.message.includes('[REDACTED]') && error.cause === undefined,
  );
});

test('storage URLs reject credentials and untrusted suffix tricks and redact signed query strings from errors', async (t) => {
  const { path } = await fixture(t);
  const prepared = (body, url) => jsonResponse({
    uploadId: 'upl_storage', projectId: 'prj', contentId: 'cnt_storage', checksum: body.sha256,
    lane: 'single-put', upload: { method: 'PUT', url, headers: {} },
  });
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (_url, options) => prepared(JSON.parse(options.body), 'https://user:password@storage.example/file'),
  }), /must not contain URL credentials/);
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (_url, options) => prepared(JSON.parse(options.body), 'https://storage.example.evil/file'),
  }), /trusted storage allowlist/);

  const signedSecret = 'X-Amz-Signature=do-not-print-this';
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/prepare')) {
        return prepared(JSON.parse(options.body), `https://storage.example/file?${signedSecret}&token=also-secret`);
      }
      throw new Error(`storage failed at ${url}`);
    },
  }), (error) => !error.message.includes(signedSecret) && !error.message.includes('also-secret') && error.message.includes('[REDACTED_QUERY]'));
});

test('the canonical B2 storage suffix is accepted without a custom allowlist entry', async (t) => {
  const { path } = await fixture(t);
  let uploaded = false;
  await uploadFile({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_b2', projectId: 'prj', contentId: 'cnt_b2', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://bucket.s3.us-west-004.backblazeb2.com/file?sig=value', headers: {} } });
      }
      if (href.startsWith('https://bucket.s3.us-west-004.backblazeb2.com/')) {
        uploaded = (await consume(options.body)).length > 0;
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) return jsonResponse({ uploadId: 'upl_b2', contentId: 'cnt_b2', status: 'processing' });
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(uploaded, true);
});

test('a leaf path swap uploads only bytes from the pinned descriptor and blocks completion', async (t) => {
  const { root, path, content } = await fixture(t, Buffer.from('trusted-original-bytes'));
  const moved = join(root, 'original-open-file.mp4');
  let putBody;
  let completed = false;
  await assert.rejects(testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_swap', projectId: 'prj', contentId: 'cnt_swap', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/swap', headers: {} } });
      }
      if (href === 'https://storage.example/swap') {
        await rename(path, moved);
        await writeFile(path, 'attacker-replacement');
        putBody = await consume(options.body);
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) completed = true;
      throw new Error(`unexpected URL ${href}`);
    },
  }), /(?:source path|local file) changed/);
  assert.deepEqual(putBody, content);
  assert.equal(completed, false);
});

test('a parent symlink swap during hashing is detected before any network request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sigmora-parent-swap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const linkedParent = join(root, 'selected');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, 'clip.mp4'), 'trusted-media');
  await writeFile(join(second, 'clip.mp4'), 'other-media');
  await symlink(first, linkedParent);
  let swapped = false;
  let fetchCalls = 0;
  await assert.rejects(uploadFile({
    filePath: join(linkedParent, 'clip.mp4'), projectId: 'prj', apiKey: 'key', retries: 0,
    onProgress: (event) => {
      if (!swapped && event.phase === 'hashing' && event.transferredBytes === event.totalBytes) {
        swapped = true;
        unlinkSync(linkedParent);
        symlinkSync(second, linkedParent);
      }
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network must not be reached');
    },
  }), /parent path changed/);
  assert.equal(fetchCalls, 0);
});

test('the pinned local descriptor is closed after an upload failure', async (t) => {
  const { path } = await fixture(t);
  try {
    await readdir('/proc/self/fd');
  } catch {
    t.skip('/proc/self/fd is unavailable on this platform');
    return;
  }
  await assert.rejects(uploadFile({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async () => { throw new Error('expected failure'); },
  }), /expected failure/);
  const openTargets = await Promise.all((await readdir('/proc/self/fd')).map(async (entry) => {
    try {
      return await readlink(`/proc/self/fd/${entry}`);
    } catch {
      return '';
    }
  }));
  assert.equal(openTargets.some((target) => target.includes(path)), false);
});

function uploadStatusBody({
  requestedUploadId = 'upl_old',
  uploadId = requestedUploadId,
  nextAction,
  state = 'uploading',
  contentStatus = 'processing',
  supersededByUploadId = uploadId === requestedUploadId ? null : uploadId,
} = {}) {
  return {
    success: true,
    requestedUploadId,
    uploadId,
    projectId: 'prj',
    assetId: 'ast_recovery',
    contentId: 'cnt_recovery',
    lane: uploadId === 'upl_old' ? 'single-put' : 'multipart',
    state,
    contentStatus,
    expiresAt: '2099-01-01T00:00:00.000Z',
    completedAt: state === 'completed' ? '2026-08-23T00:00:00.000Z' : null,
    previewUrl: null,
    supersededByUploadId,
    recovery: {
      required: nextAction !== 'none',
      attempt: uploadId === 'upl_old' ? 1 : 2,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      nextAction,
      providerAttested: nextAction !== 'upload_bytes',
    },
  };
}

test('202 completion reconciliation polls status with bounded backoff and reports the stable state', async (t) => {
  const { path } = await fixture(t);
  const calls = [];
  const sleeps = [];
  let statusCalls = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async (url, options) => {
      const href = String(url);
      calls.push(`${options.method} ${new URL(href).pathname}`);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/reconcile', headers: {} } });
      }
      if (href === 'https://storage.example/reconcile') {
        await consume(options.body);
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) return jsonResponse({ success: true, state: 'finalizing' }, 202);
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(statusCalls === 1
          ? uploadStatusBody({ nextAction: 'wait', state: 'finalizing' })
          : uploadStatusBody({ nextAction: 'none', state: 'completed', contentStatus: 'ready' }));
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(result.ingestStatus, 'ready');
  assert.equal(result.recoveryPending, undefined);
  assert.equal(statusCalls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(calls.filter((call) => call === 'PUT /reconcile').length, 1);
});

test('stale authority follows status-directed restart and uses the exact restart prepare contract', async (t) => {
  const { path, content } = await fixture(t, Buffer.from('restart-media'));
  const prepareBodies = [];
  const prepareHeaders = [];
  let uploaded;
  let completeBody;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async () => {},
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        prepareBodies.push(body);
        prepareHeaders.push(options.headers['Idempotency-Key']);
        if (!body.restartUploadId) {
          return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z', lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/expired', headers: {} } });
        }
        return jsonResponse({ uploadId: 'upl_new', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'multipart', restart: { previousUploadId: 'upl_old', attempt: 2 }, upload: { method: 'MULTIPART', partSize: 20 } });
      }
      if (href.includes('/status?')) return jsonResponse(uploadStatusBody({ nextAction: 'restart_prepare' }));
      if (href.endsWith('/parts')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ parts: [{ partNumber: 1, url: 'https://storage.example/restart-part' }] });
      }
      if (href === 'https://storage.example/restart-part') {
        uploaded = await consume(options.body);
        return new Response(null, { status: 200, headers: { ETag: 'etag-restart' } });
      }
      if (href.endsWith('/complete')) {
        completeBody = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_new', contentId: 'cnt_recovery', assetId: 'ast_recovery', status: 'processing' });
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.deepEqual(uploaded, content);
  assert.deepEqual(Object.keys(prepareBodies[1]).sort(), ['fileName', 'idempotencyKey', 'mimeType', 'projectId', 'restartUploadId', 'sha256', 'sizeBytes']);
  assert.equal(prepareBodies[1].restartUploadId, 'upl_old');
  assert.notEqual(prepareBodies[1].idempotencyKey, prepareBodies[0].idempotencyKey);
  assert.equal(prepareHeaders[1], prepareBodies[1].idempotencyKey);
  assert.equal(completeBody.uploadId, 'upl_new');
  assert.notEqual(completeBody.idempotencyKey, prepareBodies[1].idempotencyKey);
  assert.equal(result.uploadId, 'upl_new');
});

test('a lost restart response follows the ancestor pointer and replays the same restart without creating another', async (t) => {
  const { path, content } = await fixture(t, Buffer.from('lost-response-media'));
  let statusCalls = 0;
  const restartBodies = [];
  let uploadedParts = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async () => {},
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        if (!body.restartUploadId) {
          return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z', lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/expired', headers: {} } });
        }
        restartBodies.push(body);
        if (restartBodies.length === 1) throw new Error('restart response was lost after server commit');
        return jsonResponse({ uploadId: 'upl_new', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'multipart', restart: { previousUploadId: 'upl_old', attempt: 2 }, upload: { method: 'MULTIPART', partSize: 50 } });
      }
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(statusCalls === 1
          ? uploadStatusBody({ nextAction: 'restart_prepare' })
          : uploadStatusBody({ requestedUploadId: 'upl_old', uploadId: 'upl_new', nextAction: 'upload_bytes' }),
        statusCalls === 1 ? 200 : 202);
      }
      if (href.endsWith('/parts')) return jsonResponse({ parts: [{ partNumber: 1, url: 'https://storage.example/lost-part' }] });
      if (href === 'https://storage.example/lost-part') {
        uploadedParts += 1;
        assert.deepEqual(await consume(options.body), content);
        return new Response(null, { status: 200, headers: { ETag: 'etag-lost' } });
      }
      if (href.endsWith('/complete')) return jsonResponse({ uploadId: 'upl_new', contentId: 'cnt_recovery', assetId: 'ast_recovery', status: 'processing' });
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(statusCalls, 2);
  assert.equal(restartBodies.length, 2);
  assert.equal(restartBodies[0].restartUploadId, 'upl_old');
  assert.equal(restartBodies[1].restartUploadId, 'upl_old');
  assert.equal(restartBodies[0].idempotencyKey, restartBodies[1].idempotencyKey);
  assert.equal(uploadedParts, 1);
  assert.equal(result.uploadId, 'upl_new');
});

test('a 202 restart prepare is treated as recovery authority and polled before completion', async (t) => {
  const { path } = await fixture(t);
  let storagePuts = 0;
  let statusCalls = 0;
  let completeCalls = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async () => {},
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        if (!body.restartUploadId) {
          return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z', lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/expired', headers: {} } });
        }
        return jsonResponse({
          success: true,
          requestedUploadId: 'upl_old',
          uploadId: 'upl_new',
          projectId: 'prj',
          assetId: 'ast_recovery',
          contentId: 'cnt_recovery',
          state: 'restarting',
          recovery: { required: true, attempt: 2, leaseExpiresAt: '2099-01-01T00:00:00.000Z', nextAction: 'wait', providerAttested: false },
        }, 202);
      }
      if (href.includes('/status?')) {
        statusCalls += 1;
        if (statusCalls === 1) return jsonResponse(uploadStatusBody({ nextAction: 'restart_prepare', state: 'failed' }));
        return jsonResponse(uploadStatusBody({ requestedUploadId: 'upl_new', uploadId: 'upl_new', nextAction: 'retry_complete', state: 'uploaded' }));
      }
      if (href === 'https://storage.example/expired') {
        storagePuts += 1;
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) {
        completeCalls += 1;
        return jsonResponse({ uploadId: 'upl_new', contentId: 'cnt_recovery', status: 'processing' });
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(statusCalls, 2);
  assert.equal(storagePuts, 0);
  assert.equal(completeCalls, 1);
  assert.equal(result.uploadId, 'upl_new');
});

test('status-directed retry_complete does not blindly upload bytes again', async (t) => {
  const { path } = await fixture(t);
  let storagePuts = 0;
  let completeCalls = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z', lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/already-uploaded', headers: {} } });
      }
      if (href.includes('/status?')) return jsonResponse(uploadStatusBody({ nextAction: 'retry_complete', state: 'uploaded' }));
      if (href === 'https://storage.example/already-uploaded') {
        storagePuts += 1;
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) {
        completeCalls += 1;
        return jsonResponse({ uploadId: 'upl_old', contentId: 'cnt_recovery', status: 'processing' });
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(storagePuts, 0);
  assert.equal(completeCalls, 1);
  assert.equal(result.uploadId, 'upl_old');
});

test('stale deterministic prepare eviction recovers from the exact nested conflict envelope', async (t) => {
  const { path, content } = await fixture(t, Buffer.from('evicted-prepare-media'));
  const prepareBodies = [];
  let statusCalls = 0;
  let completeCalls = 0;
  let uploaded;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        prepareBodies.push(body);
        if (!body.restartUploadId) {
          return jsonResponse({
            success: false,
            error: 'This upload authority is no longer usable. Restart it with a new Idempotency-Key.',
            code: 'conflict',
            details: {
              uploadId: 'upl_old',
              projectId: 'prj',
              contentId: 'cnt_recovery',
              state: 'failed',
              statusUrl: 'https://api.sigmora.org/v1/assets/upload/status?ignored=untrusted',
              nextAction: 'restart_prepare',
              requiresNewIdempotencyKey: true,
            },
          }, 409);
        }
        return jsonResponse({ uploadId: 'upl_eviction_restart', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'multipart', restart: { previousUploadId: 'upl_old', attempt: 2 }, upload: { method: 'MULTIPART', partSize: 50 } });
      }
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(uploadStatusBody({ nextAction: 'restart_prepare', state: 'failed' }));
      }
      if (href.endsWith('/parts')) {
        return jsonResponse({ parts: [{ partNumber: 1, url: 'https://storage.example/eviction-part' }] });
      }
      if (href === 'https://storage.example/eviction-part') {
        uploaded = await consume(options.body);
        return new Response(null, { status: 200, headers: { ETag: 'etag-eviction' } });
      }
      if (href.endsWith('/complete')) {
        completeCalls += 1;
        return jsonResponse({ uploadId: 'upl_eviction_restart', contentId: 'cnt_recovery', status: 'processing' });
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(prepareBodies.length, 2);
  assert.equal(prepareBodies[0].idempotencyKey, makeUploadIdempotencyKey({
    projectId: prepareBodies[0].projectId,
    fileName: prepareBodies[0].fileName,
    sizeBytes: prepareBodies[0].sizeBytes,
    sha256: prepareBodies[0].sha256,
  }));
  assert.equal(prepareBodies[1].restartUploadId, 'upl_old');
  assert.equal(prepareBodies[1].idempotencyKey, makeRestartIdempotencyKey({
    previousIdempotencyKey: prepareBodies[0].idempotencyKey,
    restartUploadId: 'upl_old',
  }));
  assert.equal(statusCalls, 1);
  assert.equal(completeCalls, 1);
  assert.deepEqual(uploaded, content);
  assert.equal(result.uploadId, 'upl_eviction_restart');
});

test('a lost successful completion response resolves through status without re-uploading bytes', async (t) => {
  const { path } = await fixture(t);
  let storagePuts = 0;
  let completeCalls = 0;
  let statusCalls = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/lost-complete', headers: {} } });
      }
      if (href === 'https://storage.example/lost-complete') {
        storagePuts += 1;
        await consume(options.body);
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) {
        completeCalls += 1;
        throw new Error('connection closed after the server committed completion');
      }
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(uploadStatusBody({ nextAction: 'none', state: 'completed', contentStatus: 'ready' }));
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(storagePuts, 1);
  assert.equal(completeCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(result.ingestStatus, 'ready');
});

test('a generic completion 409 checks durable status then retries only completion with the same key', async (t) => {
  const { path } = await fixture(t);
  let storagePuts = 0;
  let statusCalls = 0;
  const completionKeys = [];
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/conflict-complete', headers: {} } });
      }
      if (href === 'https://storage.example/conflict-complete') {
        storagePuts += 1;
        await consume(options.body);
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) {
        const body = JSON.parse(options.body);
        completionKeys.push(body.idempotencyKey);
        if (completionKeys.length === 1) return jsonResponse({ success: false, error: 'A request with this Idempotency-Key is already in progress.', code: 'conflict' }, 409);
        return jsonResponse({ uploadId: 'upl_old', contentId: 'cnt_recovery', status: 'processing' });
      }
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(uploadStatusBody({ nextAction: 'retry_complete', state: 'uploaded' }));
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.equal(storagePuts, 1);
  assert.equal(statusCalls, 1);
  assert.equal(completionKeys.length, 2);
  assert.equal(completionKeys[0], completionKeys[1]);
  assert.equal(result.uploadId, 'upl_old');
});

test('bounded unresolved reconciliation returns an honest pending result rather than claiming ready', async (t) => {
  const { path } = await fixture(t);
  let statusCalls = 0;
  const result = await testUpload({
    filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async () => {},
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/prepare')) {
        const body = JSON.parse(options.body);
        return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/pending', headers: {} } });
      }
      if (href === 'https://storage.example/pending') {
        await consume(options.body);
        return new Response(null, { status: 200 });
      }
      if (href.endsWith('/complete')) return jsonResponse({ success: true, state: 'finalizing' }, 202);
      if (href.includes('/status?')) {
        statusCalls += 1;
        return jsonResponse(uploadStatusBody({ nextAction: 'wait', state: 'finalizing', contentStatus: 'processing' }), 202);
      }
      throw new Error(`unexpected URL ${href}`);
    },
  });
  assert.ok(statusCalls > 0);
  assert.equal(result.ingestStatus, 'processing');
  assert.equal(result.recoveryPending, true);
  assert.equal(result.recoveryNextAction, 'wait');
});

for (const contentStatus of ['missing', 'deleted']) {
  test(`a status that settles the upload as failed (${contentStatus}) is an error, not a completed upload`, async (t) => {
    const { path } = await fixture(t);
    const calls = [];
    await assert.rejects(
      testUpload({
        filePath: path, projectId: 'prj', apiKey: 'key', retries: 0, sleep: async () => {},
        fetchImpl: async (url, options) => {
          const href = String(url);
          calls.push(`${options.method} ${new URL(href).pathname}`);
          if (href.endsWith('/prepare')) {
            const body = JSON.parse(options.body);
            // A replayed session whose prepare authority has expired: the CLI asks status.
            return jsonResponse({ uploadId: 'upl_old', projectId: 'prj', assetId: 'ast_recovery', contentId: 'cnt_recovery', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z', lane: 'single-put', upload: { method: 'PUT', url: 'https://storage.example/expired', headers: {} } });
          }
          if (href.includes('/status?')) {
            return jsonResponse(uploadStatusBody({ nextAction: 'none', state: 'failed', contentStatus }));
          }
          throw new Error(`unexpected URL ${href}`);
        },
      }),
      new RegExp(`upload failed.*${contentStatus}`, 'i'),
    );
    assert.ok(!calls.includes('PUT /expired'), 'no bytes were sent');
  });
}
