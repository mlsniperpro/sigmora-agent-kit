import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HOST_NAMES, HOSTS, KIT_ROOT, readHostTemplate } from '../lib/config.js';

const readJson = async (path) => JSON.parse(await readFile(join(KIT_ROOT, path), 'utf8'));

test('package is versioned ESM with Node 20 and zero runtime dependencies', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.name, '@sigmora/agent-kit');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=20');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.bin.sigmora, './bin/sigmora.js');
});

test('Codex, Claude, and ZCode manifests align with the root plugin.json', async () => {
  const root = await readJson('plugin.json');
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.zcode-plugin/plugin.json']) {
    const manifest = await readJson(path);
    assert.equal(manifest.name, 'sigmora', path);
    assert.equal(manifest.version, root.version, path);
    assert.equal(manifest.author.name, 'Sigmora', path);
    assert.equal(manifest.homepage, 'https://docs.sigmora.org/mcp-server', path);
    assert.equal(
      manifest.mcpServers,
      {
        '.codex-plugin/plugin.json': './.mcp.json',
        '.claude-plugin/plugin.json': './templates/claude/.mcp.json',
        '.zcode-plugin/plugin.json': './templates/zcode/.mcp.json',
      }[path],
      path,
    );
  }
  const codex = await readJson('.codex-plugin/plugin.json');
  assert.equal(codex.skills, './skills/');
  assert.ok(Array.isArray(codex.interface.defaultPrompt));
  assert.ok(codex.interface.defaultPrompt.length <= 3);
});

test('every host template uses the canonical endpoint and documented non-secret auth', async () => {
  assert.equal(HOST_NAMES.length, 11);
  for (const host of HOST_NAMES) {
    const template = await readHostTemplate(host);
    const serialized = typeof template === 'string' ? template : JSON.stringify(template);
    assert.match(serialized, /https:\/\/api\.sigmora\.org\/mcp/, host);
    if (HOSTS[host].auth === 'environment') {
      assert.match(serialized, /SIGMORA_API_KEY/, host);
    } else {
      assert.doesNotMatch(serialized, /SIGMORA_API_KEY|Authorization/, host);
    }
    assert.doesNotMatch(serialized, /\b(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE|QWEN|KIMI|DEEPSEEK|GLM|CODEBUDDY|HEYGEN)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\b/i, host);
  }
});

test('host templates use current host-native remote MCP fields', async () => {
  const canonical = await readJson('.mcp.json');
  assert.equal(canonical.mcpServers.sigmora.bearer_token_env_var, 'SIGMORA_API_KEY');
  assert.equal(canonical.mcpServers.sigmora.headers.Authorization, 'Bearer ${SIGMORA_API_KEY}');

  const codexPluginTemplate = await readJson('templates/codex/.mcp.json');
  assert.equal(codexPluginTemplate.mcpServers.sigmora.bearer_token_env_var, 'SIGMORA_API_KEY');
  assert.equal(codexPluginTemplate.mcpServers.sigmora.headers.Authorization, 'Bearer ${SIGMORA_API_KEY}');

  for (const path of ['templates/claude/.mcp.json', 'templates/zcode/.mcp.json', 'templates/codebuddy/.mcp.json']) {
    const template = await readJson(path);
    assert.equal(template.mcpServers.sigmora.bearer_token_env_var, undefined, path);
    assert.equal(template.mcpServers.sigmora.headers.Authorization, 'Bearer ${SIGMORA_API_KEY}', path);
  }

  const codex = await readHostTemplate('codex');
  assert.match(codex, /\[mcp_servers\.sigmora\]/);
  assert.match(codex, /bearer_token_env_var = "SIGMORA_API_KEY"/);

  const openCode = await readHostTemplate('opencode');
  assert.equal(openCode.mcp.servers.sigmora.type, 'remote');
  assert.equal(openCode.mcp.servers.sigmora.headers.Authorization, 'Bearer {env:SIGMORA_API_KEY}');

  const antigravity = await readHostTemplate('antigravity');
  assert.equal(antigravity.mcpServers.sigmora.serverUrl, 'https://api.sigmora.org/mcp');
  assert.equal(antigravity.mcpServers.sigmora.url, undefined);
  assert.equal(antigravity.mcpServers.sigmora.headers, undefined);

  const qwen = await readHostTemplate('qwen');
  assert.equal(qwen.mcpServers.sigmora.httpUrl, 'https://api.sigmora.org/mcp');
  assert.equal(qwen.mcpServers.sigmora.authProviderType, 'dynamic_discovery');
  assert.equal(qwen.mcpServers.sigmora.trust, false);

  const cursor = await readHostTemplate('cursor');
  assert.equal(cursor.mcpServers.sigmora.type, 'http');
  assert.equal(cursor.mcpServers.sigmora.headers, undefined);

  const gemini = await readHostTemplate('gemini');
  assert.equal(gemini.mcpServers.sigmora.authProviderType, 'dynamic_discovery');
  assert.equal(gemini.mcpServers.sigmora.trust, false);

  const kimi = await readHostTemplate('kimi');
  assert.equal(kimi.mcpServers.sigmora.bearerTokenEnvVar, 'SIGMORA_API_KEY');
  assert.equal(kimi.mcpServers.sigmora.headers, undefined);

  const deepSeek = await readHostTemplate('deepseek');
  assert.match(deepSeek, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(deepSeek, /transport: streamable-http/);
});

test('repository marketplace points to the native Codex plugin', async () => {
  const marketplacePath = resolve(KIT_ROOT, '../../.agents/plugins/marketplace.json');
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'sigmora');
  assert.ok(entry);
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './plugins/sigmora');
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.ok(entry.category);
});

test('portable skill contains project, review, billing, partner, continuation, and injection invariants', async () => {
  const skill = await readFile(join(KIT_ROOT, 'skills/sigmora-media/SKILL.md'), 'utf8');
  for (const expected of ['projectId', 'externalSessionId', 'artifacts_only', 'review', 'idempotency', 'provider_billed_external', 'partner', 'runtime', 'untrusted']) {
    assert.match(skill, new RegExp(expected, 'i'), expected);
  }
  const contract = await readFile(join(KIT_ROOT, 'skills/sigmora-media/references/workflow-contract.md'), 'utf8');
  for (const choice of ['retry_provider', 'continue_with_sigmora', 'open_dashboard', 'cancel']) assert.match(contract, new RegExp(choice));
});
