import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { doctor, runCli } from '../lib/cli.js';
import { installHosts } from '../lib/config.js';

const REQUIRED_TOOLS = [
  'project_session_start',
  'project_context_get',
  'assets_list',
  'assets_get',
  'assets_ingest_get',
  'assets_upload_prepare',
  'assets_upload_complete',
  'jobs_proposal_get',
  'capabilities_list',
];

function mcpResponse(value, status = 200, headers = {}) {
  return new Response(status === 202 && value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
}

function capture() {
  let value = '';
  return { stream: { write(chunk) { value += String(chunk); } }, value: () => value };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sigmora-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('doctor passes current config and never reports the API key value', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const result = await doctor({ hosts: ['claude'], root, env: { SIGMORA_API_KEY: 'secret-value' } });
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.host === 'claude').name, 'configuration');
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test('network doctor sends only Sigmora auth and accepts an MCP response', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const requests = [];
  const result = await doctor({
    hosts: ['claude'], root, network: true,
    env: { SIGMORA_API_KEY: 'sigmora-key', OPENAI_API_KEY: 'provider-key' },
    fetchImpl: async (url, options) => {
      const request = { url: String(url), options, body: JSON.parse(options.body) };
      requests.push(request);
      if (request.body.method === 'initialize') {
        return mcpResponse({ jsonrpc: '2.0', id: request.body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }, 200, { 'Mcp-Session-Id': 'session-1' });
      }
      if (request.body.method === 'notifications/initialized') return mcpResponse(undefined, 202);
      if (request.body.method === 'tools/list') {
        return mcpResponse({ jsonrpc: '2.0', id: request.body.id, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
      }
      return mcpResponse({
        jsonrpc: '2.0',
        id: request.body.id,
        result: {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { success: true, version: 'v1', operations: ['assets.list'] },
          isError: false,
        },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer sigmora-key');
  for (const request of requests.slice(1)) {
    assert.equal(request.options.headers.Authorization, 'Bearer sigmora-key');
    assert.equal(request.options.headers['Mcp-Session-Id'], 'session-1');
  }
  assert.doesNotMatch(JSON.stringify(requests), /provider-key/);
  assert.equal(requests[0].body.method, 'initialize');
  assert.deepEqual(requests.map((request) => request.body.method), [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call',
  ]);
  assert.equal(requests[3].body.params.name, 'capabilities_list');
  assert.deepEqual(requests[3].body.params.arguments, {});
});

test('network doctor fails when initialize succeeds but authenticated capabilities rejects the key', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const secret = 'random-invalid-key';
  const result = await doctor({
    hosts: ['claude'], root, network: true, env: { SIGMORA_API_KEY: secret },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') {
        return mcpResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
      }
      if (body.method === 'notifications/initialized') return mcpResponse(undefined, 202);
      if (body.method === 'tools/list') return mcpResponse({ jsonrpc: '2.0', id: body.id, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
      return mcpResponse({ error: `Invalid bearer token ${secret}` }, 401);
    },
  });
  assert.equal(result.ok, false);
  const network = result.checks.find((check) => check.name === 'network');
  assert.equal(network.status, 'capabilities-http-401');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('network doctor rejects incomplete tool inventory and arbitrary tool content', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const baseFetch = async (_url, options, badCapabilities = false) => {
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return mcpResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
    if (body.method === 'notifications/initialized') return mcpResponse(undefined, 202);
    if (body.method === 'tools/list') return mcpResponse({ jsonrpc: '2.0', id: body.id, result: { tools: (badCapabilities ? REQUIRED_TOOLS : REQUIRED_TOOLS.slice(1)).map((name) => ({ name })) } });
    return mcpResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'anything' }], isError: false } });
  };
  const missing = await doctor({
    hosts: ['claude'], root, network: true, env: { SIGMORA_API_KEY: 'key' },
    fetchImpl: (url, options) => baseFetch(url, options, false),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find((check) => check.name === 'network').status, 'required-tools-missing');

  const arbitrary = await doctor({
    hosts: ['claude'], root, network: true, env: { SIGMORA_API_KEY: 'key' },
    fetchImpl: (url, options) => baseFetch(url, options, true),
  });
  assert.equal(arbitrary.ok, false);
  assert.equal(arbitrary.checks.find((check) => check.name === 'network').status, 'invalid-capabilities');
});

test('OAuth host doctor is blocked offline and passes only when network metadata advertises an issuer', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['qwen'], root });
  const offline = await doctor({ hosts: ['qwen'], root, env: { SIGMORA_API_KEY: 'unused-key' } });
  assert.equal(offline.ok, false);
  assert.equal(offline.checks.find((check) => check.name === 'oauth').status, 'deployment-required');

  const missingIssuer = await doctor({
    hosts: ['qwen'], root, network: true, env: {},
    fetchImpl: async () => new Response(JSON.stringify({ resource: 'https://api.sigmora.org/mcp' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  });
  assert.equal(missingIssuer.ok, false);
  assert.equal(missingIssuer.checks.find((check) => check.name === 'oauth').status, 'issuer-missing');

  const online = await doctor({
    hosts: ['qwen'], root, network: true, env: { SIGMORA_API_KEY: 'unused-key' },
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://api.sigmora.org/.well-known/oauth-protected-resource/mcp');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, undefined);
      return new Response(JSON.stringify({
        resource: 'https://api.sigmora.org/mcp',
        authorization_servers: ['https://identity.sigmora.org'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(online.ok, true);
  assert.equal(online.checks.find((check) => check.name === 'oauth').status, 'discovered');
});

test('CLI install supports dry-run JSON and makes no writes', async (t) => {
  const root = await fixture(t);
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['install', '--host', 'opencode', '--root', root, '--dry-run', '--json'], { stdout: stdout.stream, stderr: stderr.stream, env: {}, cwd: root });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.value()).results[0].action, 'would-create');
  assert.equal(stderr.value(), '');
});

test('CLI rejects command-line credentials and redacts environment secrets from failures', async (t) => {
  const root = await fixture(t);
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['doctor', '--api-key', 'forbidden-secret'], {
    stdout: stdout.stream, stderr: stderr.stream, env: { SIGMORA_API_KEY: 'environment-secret' }, cwd: root,
  });
  assert.equal(code, 1);
  assert.match(stderr.value(), /only through SIGMORA_API_KEY/);
  assert.doesNotMatch(stderr.value(), /forbidden-secret|environment-secret/);
});

test('CLI doctor returns nonzero when auth or config is missing', async (t) => {
  const root = await fixture(t);
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['doctor', '--host', 'claude', '--root', root, '--json'], { stdout: stdout.stream, stderr: stderr.stream, env: {}, cwd: root });
  assert.equal(code, 1);
  const report = JSON.parse(stdout.value());
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.name === 'authentication' && !check.ok));
});

test('project-controlled custom API and MCP environment origins cannot receive the bearer key without CLI opt-in', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const filePath = join(root, 'clip.mp4');
  await writeFile(filePath, 'media-bytes');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('fetch must not run for an untrusted origin');
  };

  const doctorOut = capture();
  const doctorCode = await runCli(['doctor', '--host', 'claude', '--root', root, '--network', '--json'], {
    stdout: doctorOut.stream,
    stderr: capture().stream,
    env: { SIGMORA_API_KEY: 'origin-secret', SIGMORA_MCP_URL: 'https://poisoned.example/mcp' },
    cwd: root,
    fetchImpl,
  });
  assert.equal(doctorCode, 1);
  assert.equal(JSON.parse(doctorOut.value()).checks.find((check) => check.name === 'network').status, 'error');

  const uploadErr = capture();
  const uploadCode = await runCli(['upload', filePath, '--project', 'prj'], {
    stdout: capture().stream,
    stderr: uploadErr.stream,
    env: { SIGMORA_API_KEY: 'origin-secret', SIGMORA_API_BASE_URL: 'https://poisoned.example' },
    cwd: root,
    fetchImpl,
  });
  assert.equal(uploadCode, 1);
  assert.match(uploadErr.value(), /--allow-custom-origin/);
  assert.doesNotMatch(uploadErr.value(), /origin-secret/);
  assert.equal(calls, 0);
});

test('CLI upload wires arguments through mocked prepare, storage PUT, and complete', async (t) => {
  const root = await fixture(t);
  const filePath = join(root, 'clip.mp4');
  await writeFile(filePath, 'media-bytes');
  const stdout = capture();
  const stderr = capture();
  const methods = [];
  const fetchImpl = async (url, options) => {
    const href = String(url);
    methods.push(`${options.method} ${new URL(href).pathname}`);
    if (href.endsWith('/v1/assets/upload/prepare')) {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({
        uploadId: 'upl_cli', projectId: 'prj_cli', assetId: 'ast_cli', contentId: 'cnt_cli',
        lane: 'single-put', checksum: body.sha256,
        upload: { method: 'PUT', url: 'https://storage.example/cli', headers: {} },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href === 'https://storage.example/cli') {
      for await (const _chunk of options.body) { /* consume the upload stream */ }
      return new Response(null, { status: 200 });
    }
    if (href.endsWith('/v1/assets/upload/complete')) {
      return new Response(JSON.stringify({ assetId: 'ast_cli', contentId: 'cnt_cli', status: 'ready' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL ${href}`);
  };
  const code = await runCli(['upload', filePath, '--project', 'prj_cli', '--storage-host', 'storage.example', '--json', '--quiet'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { SIGMORA_API_KEY: 'cli-secret' },
    cwd: root,
    fetchImpl,
  });
  assert.equal(code, 0);
  assert.equal(stderr.value(), '');
  assert.equal(JSON.parse(stdout.value()).assetId, 'ast_cli');
  assert.deepEqual(methods, [
    'POST /v1/assets/upload/prepare',
    'PUT /cli',
    'POST /v1/assets/upload/complete',
  ]);
  assert.doesNotMatch(`${stdout.value()}${stderr.value()}`, /cli-secret/);
});

function uploadStatusResponse({ nextAction, state, contentStatus }, status = 200) {
  return new Response(JSON.stringify({
    success: true, requestedUploadId: 'upl_cli', uploadId: 'upl_cli', projectId: 'prj_cli',
    assetId: 'ast_cli', contentId: 'cnt_cli', lane: 'single-put', state, contentStatus,
    expiresAt: '2000-01-01T00:00:00.000Z', completedAt: null, previewUrl: null, supersededByUploadId: null,
    recovery: { required: nextAction !== 'none', attempt: 1, leaseExpiresAt: null, nextAction, providerAttested: true },
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

function expiredPrepareResponse(options) {
  const body = JSON.parse(options.body);
  return new Response(JSON.stringify({
    uploadId: 'upl_cli', projectId: 'prj_cli', assetId: 'ast_cli', contentId: 'cnt_cli',
    lane: 'single-put', checksum: body.sha256, expiresAt: '2000-01-01T00:00:00.000Z',
    upload: { method: 'PUT', url: 'https://storage.example/cli', headers: {} },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('CLI upload exits nonzero and never says Uploaded when the server reports the upload failed', async (t) => {
  const root = await fixture(t);
  const filePath = join(root, 'clip.mp4');
  await writeFile(filePath, 'media-bytes');
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['upload', filePath, '--project', 'prj_cli', '--storage-host', 'storage.example', '--quiet'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { SIGMORA_API_KEY: 'cli-secret' },
    cwd: root,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/v1/assets/upload/prepare')) return expiredPrepareResponse(options);
      if (href.includes('/v1/assets/upload/status?')) {
        return uploadStatusResponse({ nextAction: 'none', state: 'failed', contentStatus: 'missing' });
      }
      throw new Error(`Unexpected URL ${href}`);
    },
  });
  assert.notEqual(code, 0);
  assert.doesNotMatch(stdout.value(), /Uploaded/);
  assert.match(stderr.value(), /upload failed/i);
});

test('CLI upload text output does not call a still-reconciling upload Uploaded', async (t) => {
  const root = await fixture(t);
  const filePath = join(root, 'clip.mp4');
  await writeFile(filePath, 'media-bytes');
  const stdout = capture();
  const code = await runCli(['upload', filePath, '--project', 'prj_cli', '--storage-host', 'storage.example', '--quiet', '--retries', '0'], {
    stdout: stdout.stream,
    stderr: capture().stream,
    env: { SIGMORA_API_KEY: 'cli-secret' },
    cwd: root,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.endsWith('/v1/assets/upload/prepare')) return expiredPrepareResponse(options);
      if (href.includes('/v1/assets/upload/status?')) {
        return uploadStatusResponse({ nextAction: 'wait', state: 'finalizing', contentStatus: 'processing' }, 202);
      }
      throw new Error(`Unexpected URL ${href}`);
    },
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stdout.value(), /^Uploaded/m);
  assert.match(stdout.value(), /still reconciling/);
});
