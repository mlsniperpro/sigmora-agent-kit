import { HOSTS, inspectHost, installHosts, uninstallHosts, expandHosts } from './config.js';
import { assertSecureUrl, assertTrustedSigmoraOrigin, DEFAULT_API_BASE, uploadFile } from './upload.js';

const VERSION = '0.1.1';
const BOOLEAN_OPTIONS = new Set(['dry-run', 'force', 'json', 'network', 'quiet', 'help', 'version', 'allow-custom-origin']);
const VALUE_OPTIONS = new Set(['host', 'scope', 'root', 'project', 'title', 'mime', 'api-base', 'mcp-url', 'retries', 'storage-host']);
const REQUIRED_MCP_TOOLS = Object.freeze([
  'project_session_start',
  'project_context_get',
  'assets_list',
  'assets_get',
  'assets_ingest_get',
  'assets_upload_prepare',
  'assets_upload_complete',
  'jobs_proposal_get',
  'capabilities_list',
]);

const HELP = `Sigmora Agent Kit ${VERSION}

Usage:
  sigmora install [--host HOST|all] [--scope project|user] [--root DIR] [--dry-run] [--force] [--json]
  sigmora doctor [--host HOST|all] [--scope project|user] [--root DIR] [--network] [--mcp-url URL] [--allow-custom-origin] [--json]
  sigmora upload <file> --project PROJECT_ID [--title TITLE] [--mime TYPE] [--api-base URL] [--allow-custom-origin] [--storage-host HOST] [--retries 0..5] [--json] [--quiet]
  sigmora uninstall [--host HOST|all] [--scope project|user] [--root DIR] [--dry-run] [--force] [--json]

Authentication:
  Export SIGMORA_API_KEY for CLI uploads and environment-authenticated hosts.
  OAuth-discovery hosts authenticate interactively. The CLI never accepts,
  stores, or prints API keys and never reads model-provider credentials.

Hosts:
  codex, claude, opencode, antigravity, qwen, kimi, deepseek, zcode,
  codebuddy, cursor, gemini
`;

function parseArguments(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (name === 'api-key' || name === 'token') {
      throw new Error('Credentials are accepted only through SIGMORA_API_KEY; remove the CLI credential argument.');
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      if (equals >= 0) throw new Error(`--${name} does not accept a value.`);
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option --${name}.`);
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    if (name === 'host' || name === 'storage-host') options[name] = [...(options[name] ?? []), value];
    else options[name] = value;
  }
  return { options, positionals };
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printConfigResults(results, stdout, json) {
  if (json) return writeJson(stdout, { ok: true, results });
  for (const result of results) {
    stdout.write(`${result.host}: ${result.action} ${result.path}${result.backup ? ` (backup: ${result.backup})` : ''}\n`);
  }
}

function parseRetries(value) {
  if (value === undefined) return 2;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) throw new Error('--retries must be an integer from 0 to 5.');
  return parsed;
}

function progressReporter(stderr, { json, quiet }) {
  let lastPhase;
  let lastBucket = -1;
  return (event) => {
    if (quiet) return;
    const percent = event.totalBytes ? Math.floor((event.transferredBytes / event.totalBytes) * 100) : 0;
    const bucket = Math.floor(percent / 5);
    if (event.phase === lastPhase && bucket === lastBucket && event.phase !== 'complete') return;
    lastPhase = event.phase;
    lastBucket = bucket;
    if (json) stderr.write(`${JSON.stringify({ type: 'progress', ...event, percent })}\n`);
    else stderr.write(`${event.phase}: ${percent}% (${event.transferredBytes}/${event.totalBytes} bytes)${event.partNumber ? ` part ${event.partNumber}/${event.partCount}` : ''}\n`);
  };
}

async function parseMcpPayload(response) {
  const text = await response.text();
  const contentType = response.headers?.get?.('content-type') ?? '';
  const candidates = contentType.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    : [text];
  for (const candidate of candidates) {
    if (!candidate || candidate === '[DONE]') continue;
    try {
      const payload = JSON.parse(candidate);
      if (payload && typeof payload === 'object') return payload;
    } catch {
      // Try the next SSE data event before reporting an invalid response.
    }
  }
  return null;
}

async function networkDoctor({ mcpUrl, apiKey, fetchImpl, allowCustomOrigin }) {
  if (!apiKey) return { name: 'network', ok: false, status: 'missing-key', message: 'SIGMORA_API_KEY is not set' };
  try {
    const url = assertTrustedSigmoraOrigin(mcpUrl, 'Sigmora MCP URL', { allowCustomOrigin });
    const baseHeaders = {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': `sigmora-agent-kit/${VERSION}`,
    };
    const initialize = await fetchImpl(url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'sigmora-doctor-initialize',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'sigmora-agent-kit-doctor', version: VERSION },
        },
      }),
      redirect: 'error',
    });
    if (!initialize.ok) {
      return { name: 'network', ok: false, status: `initialize-http-${initialize.status}`, message: `MCP initialize was rejected (HTTP ${initialize.status})` };
    }
    const initializePayload = await parseMcpPayload(initialize);
    if (initializePayload?.jsonrpc !== '2.0' || !initializePayload.result || initializePayload.error) {
      return { name: 'network', ok: false, status: 'invalid-initialize', message: 'MCP initialize did not return a successful protocol result' };
    }

    const sessionId = initialize.headers?.get?.('mcp-session-id');
    const protocolVersion = initializePayload.result.protocolVersion ?? '2025-06-18';
    const sessionHeaders = {
      ...baseHeaders,
      'MCP-Protocol-Version': protocolVersion,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    };
    const initialized = await fetchImpl(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      redirect: 'error',
    });
    if (!initialized.ok) {
      return { name: 'network', ok: false, status: `initialized-http-${initialized.status}`, message: `MCP initialized notification was rejected (HTTP ${initialized.status})` };
    }

    const toolsResponse = await fetchImpl(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'sigmora-doctor-tools', method: 'tools/list', params: {} }),
      redirect: 'error',
    });
    if (!toolsResponse.ok) {
      return { name: 'network', ok: false, status: `tools-http-${toolsResponse.status}`, message: `MCP tool inventory was rejected (HTTP ${toolsResponse.status})` };
    }
    const toolsPayload = await parseMcpPayload(toolsResponse);
    const toolNames = new Set(
      Array.isArray(toolsPayload?.result?.tools)
        ? toolsPayload.result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
        : [],
    );
    const missingTools = REQUIRED_MCP_TOOLS.filter((name) => !toolNames.has(name));
    if (toolsPayload?.jsonrpc !== '2.0' || toolsPayload.error || missingTools.length) {
      return {
        name: 'network',
        ok: false,
        status: 'required-tools-missing',
        message: missingTools.length
          ? `MCP deployment is missing required Sigmora tools: ${missingTools.join(', ')}`
          : 'MCP tool inventory did not return a successful protocol result',
      };
    }

    const capabilities = await fetchImpl(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'sigmora-doctor-capabilities',
        method: 'tools/call',
        params: { name: 'capabilities_list', arguments: {} },
      }),
      redirect: 'error',
    });
    if (!capabilities.ok) {
      return {
        name: 'network',
        ok: false,
        status: `capabilities-http-${capabilities.status}`,
        message: `Authenticated capabilities check was rejected (HTTP ${capabilities.status})`,
      };
    }
    const capabilitiesPayload = await parseMcpPayload(capabilities);
    const result = capabilitiesPayload?.result;
    if (
      capabilitiesPayload?.jsonrpc !== '2.0'
      || capabilitiesPayload.error
      || !result
      || typeof result !== 'object'
      || result.isError === true
      || !Array.isArray(result.content)
      || result.structuredContent?.success !== true
      || result.structuredContent?.version !== 'v1'
      || !Array.isArray(result.structuredContent?.operations)
      || result.structuredContent.operations.length < 1
    ) {
      return { name: 'network', ok: false, status: 'invalid-capabilities', message: 'Authenticated capabilities check did not return a successful MCP tool result' };
    }
    return { name: 'network', ok: true, status: 'authenticated', message: 'SIGMORA_API_KEY authenticated and capabilities_list succeeded' };
  } catch (error) {
    const message = String(error?.message || error).split(apiKey).join('[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    return { name: 'network', ok: false, status: 'error', message: message.slice(0, 300) };
  }
}

async function oauthDoctor({ mcpUrl, fetchImpl, allowCustomOrigin }) {
  try {
    const resource = assertTrustedSigmoraOrigin(mcpUrl, 'Sigmora MCP URL', { allowCustomOrigin });
    const metadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`, resource);
    const response = await fetchImpl(metadataUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': `sigmora-agent-kit/${VERSION}` },
      redirect: 'error',
    });
    if (!response.ok) {
      return { name: 'oauth', ok: false, status: `metadata-http-${response.status}`, message: `OAuth protected-resource metadata was rejected (HTTP ${response.status})` };
    }
    const metadata = await response.json().catch(() => null);
    if (metadata?.resource !== resource.toString() || !Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length < 1) {
      return { name: 'oauth', ok: false, status: 'issuer-missing', message: 'OAuth metadata does not advertise an authorization server for the selected MCP resource' };
    }
    for (const issuer of metadata.authorization_servers) assertSecureUrl(issuer, 'OAuth authorization server');
    return { name: 'oauth', ok: true, status: 'discovered', message: 'OAuth protected-resource metadata advertises a secure authorization server' };
  } catch (error) {
    return { name: 'oauth', ok: false, status: 'error', message: String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 300) };
  }
}

export async function doctor({ hosts, scope = 'project', root, home, network = false, mcpUrl = 'https://api.sigmora.org/mcp', allowCustomOrigin = false, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: nodeMajor >= 20, status: process.versions.node, message: nodeMajor >= 20 ? 'Node.js version is supported' : 'Node.js 20 or newer is required' });
  const selectedHosts = expandHosts(hosts ?? ['codex']);
  const environmentHosts = selectedHosts.filter((host) => HOSTS[host].auth === 'environment');
  const oauthHosts = selectedHosts.filter((host) => HOSTS[host].auth === 'oauth');
  const apiKey = env.SIGMORA_API_KEY;
  if (environmentHosts.length) {
    checks.push({
        name: 'authentication',
        ok: Boolean(apiKey),
        status: apiKey ? 'environment' : 'missing',
        message: apiKey
          ? `SIGMORA_API_KEY is available for ${environmentHosts.join(', ')}`
          : `SIGMORA_API_KEY is required by ${environmentHosts.join(', ')}`,
      });
  }
  if (oauthHosts.length) {
    checks.push(network
      ? await oauthDoctor({ mcpUrl, fetchImpl, allowCustomOrigin })
      : {
          name: 'oauth',
          ok: false,
          status: 'deployment-required',
          message: `OAuth deployment must be verified with --network for ${oauthHosts.join(', ')}; these templates do not use SIGMORA_API_KEY`,
        });
  }
  for (const host of selectedHosts) {
    checks.push({ name: 'configuration', ...await inspectHost(host, { scope, root, home }) });
  }
  if (network && environmentHosts.length) checks.push(await networkDoctor({ mcpUrl, apiKey, fetchImpl, allowCustomOrigin }));
  return { ok: checks.every((check) => check.ok), checks };
}

function assertNoExtraPositionals(positionals, command) {
  if (positionals.length) throw new Error(`${command} does not accept positional arguments.`);
}

export async function runCli(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  cwd = process.cwd(),
  home,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    if (!argv.length || argv.includes('--help')) {
      stdout.write(HELP);
      return 0;
    }
    if (argv.length === 1 && argv[0] === '--version') {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    const command = argv[0];
    const { options, positionals } = parseArguments(argv.slice(1));
    const hosts = options.host ?? ['codex'];
    const common = {
      hosts,
      scope: options.scope ?? 'project',
      root: options.root ?? cwd,
      home,
      dryRun: Boolean(options['dry-run']),
      force: Boolean(options.force),
    };

    if (command === 'install') {
      assertNoExtraPositionals(positionals, command);
      const results = await installHosts(common);
      printConfigResults(results, stdout, options.json);
      return 0;
    }
    if (command === 'uninstall') {
      assertNoExtraPositionals(positionals, command);
      const results = await uninstallHosts(common);
      printConfigResults(results, stdout, options.json);
      return 0;
    }
    if (command === 'doctor') {
      assertNoExtraPositionals(positionals, command);
      const result = await doctor({
        hosts,
        scope: common.scope,
        root: common.root,
        home,
        network: Boolean(options.network),
        mcpUrl: options['mcp-url'] ?? env.SIGMORA_MCP_URL ?? 'https://api.sigmora.org/mcp',
        allowCustomOrigin: Boolean(options['allow-custom-origin']),
        env,
        fetchImpl,
      });
      if (options.json) writeJson(stdout, result);
      else for (const check of result.checks) stdout.write(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.host ? `/${check.host}` : ''}: ${check.message}${check.path ? ` (${check.path})` : ''}\n`);
      return result.ok ? 0 : 1;
    }
    if (command === 'upload') {
      if (positionals.length !== 1) throw new Error('upload requires exactly one local file path.');
      if (options.host || options.scope || options.root || options['dry-run'] || options.force || options.network || options['mcp-url']) {
        throw new Error('upload received an option that applies only to install, doctor, or uninstall.');
      }
      const result = await uploadFile({
        filePath: positionals[0],
        projectId: options.project,
        title: options.title,
        mimeType: options.mime,
        apiBase: options['api-base'] ?? env.SIGMORA_API_BASE_URL ?? DEFAULT_API_BASE,
        allowCustomOrigin: Boolean(options['allow-custom-origin']),
        storageHosts: options['storage-host'],
        apiKey: env.SIGMORA_API_KEY,
        fetchImpl,
        retries: parseRetries(options.retries),
        onProgress: progressReporter(stderr, { json: Boolean(options.json), quiet: Boolean(options.quiet) }),
      });
      if (options.json) writeJson(stdout, result);
      else {
        stdout.write(result.recoveryPending
          ? `Upload of ${result.fileName} to project ${result.projectId} submitted; completion still reconciling.\n`
          : `Uploaded ${result.fileName} to project ${result.projectId}.\n`);
        stdout.write(`assetId=${result.assetId ?? 'pending'} contentId=${result.contentId} status=${result.ingestStatus} sha256=${result.sha256}\n`);
      }
      return 0;
    }
    throw new Error(`Unknown command "${command}". Run sigmora --help.`);
  } catch (error) {
    const secret = env.SIGMORA_API_KEY;
    let message = String(error?.message || error);
    if (secret) message = message.split(secret).join('[REDACTED]');
    message = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    stderr.write(`sigmora: ${message}\n`);
    return 1;
  }
}

export { HELP, VERSION };
