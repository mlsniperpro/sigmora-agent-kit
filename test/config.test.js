import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectHost, installHosts, uninstallHosts } from '../lib/config.js';

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'sigmora-config-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('install merges only Sigmora, creates a backup, and is idempotent', async (t) => {
  const root = await fixture(t);
  const path = join(root, '.mcp.json');
  await writeFile(path, `${JSON.stringify({ keep: { value: 42 }, mcpServers: { other: { command: 'safe' } } }, null, 2)}\n`);
  const first = await installHosts({ hosts: ['claude'], root, now: new Date('2026-08-23T12:00:00.000Z') });
  assert.equal(first[0].action, 'updated');
  assert.ok(first[0].backup);
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(updated.keep, { value: 42 });
  assert.deepEqual(updated.mcpServers.other, { command: 'safe' });
  assert.equal(updated.mcpServers.sigmora.headers.Authorization, 'Bearer ${SIGMORA_API_KEY}');
  assert.doesNotMatch(await readFile(path, 'utf8'), /actual-secret/);

  const second = await installHosts({ hosts: ['claude'], root });
  assert.equal(second[0].action, 'unchanged');
  assert.equal(second[0].backup, null);
});

test('dry-run has no filesystem side effects', async (t) => {
  const root = await fixture(t);
  const result = await installHosts({ hosts: ['opencode'], root, dryRun: true });
  assert.equal(result[0].action, 'would-create');
  await assert.rejects(readFile(join(root, 'opencode.json'), 'utf8'), { code: 'ENOENT' });
});

test('conflicting Sigmora entries require force and are backed up when replaced', async (t) => {
  const root = await fixture(t);
  const path = join(root, '.mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: { sigmora: { url: 'https://unexpected.example/mcp' } } }));
  await assert.rejects(installHosts({ hosts: ['claude'], root }), /--force/);
  const result = await installHosts({ hosts: ['claude'], root, force: true });
  assert.equal(result[0].action, 'updated');
  assert.ok(result[0].backup);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.mcpServers.sigmora.url, 'https://api.sigmora.org/mcp');
});

test('uninstall removes only the owned Sigmora entry and preserves unrelated config', async (t) => {
  const root = await fixture(t);
  await installHosts({ hosts: ['claude'], root });
  const path = join(root, '.mcp.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.keep = true;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  const result = await uninstallHosts({ hosts: ['claude'], root });
  assert.equal(result[0].action, 'updated');
  const removed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(removed.keep, true);
  assert.equal(removed.mcpServers.sigmora, undefined);
});

test('shared .mcp.json templates merge idempotently across native hosts', async (t) => {
  const root = await fixture(t);
  const results = await installHosts({ hosts: ['claude', 'zcode', 'codebuddy'], root });
  assert.deepEqual(results.map((result) => result.action), ['created', 'unchanged', 'unchanged']);
});

test('Codex fallback uses a marker-bounded config.toml block and preserves existing settings', async (t) => {
  const root = await fixture(t);
  const path = join(root, '.codex/config.toml');
  await mkdir(join(root, '.codex'));
  await writeFile(path, 'model = "gpt-example"\n');
  await installHosts({ hosts: ['codex'], root });
  const installed = await readFile(path, 'utf8');
  assert.match(installed, /\[mcp_servers\.sigmora\]/);
  assert.match(installed, /bearer_token_env_var = "SIGMORA_API_KEY"/);
  assert.match(installed, /model = "gpt-example"/);
  assert.doesNotMatch(installed, /Bearer/);
  const second = await installHosts({ hosts: ['codex'], root });
  assert.equal(second[0].action, 'unchanged');
  await uninstallHosts({ hosts: ['codex'], root });
  assert.equal(await readFile(path, 'utf8'), 'model = "gpt-example"\n');
});

test('DeepSeek marker block is append-only and safely removable', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'cordis.patch.yml');
  await writeFile(path, '- id: existing\n  name: existing-plugin\n');
  await installHosts({ hosts: ['deepseek'], root });
  const installed = await readFile(path, 'utf8');
  assert.match(installed, /id: existing/);
  assert.match(installed, /BEGIN SIGMORA AGENT KIT/);
  await uninstallHosts({ hosts: ['deepseek'], root });
  const removed = await readFile(path, 'utf8');
  assert.match(removed, /id: existing/);
  assert.doesNotMatch(removed, /SIGMORA AGENT KIT/);
});

test('installer rejects symlink targets and strict-JSON hazards', async (t) => {
  const root = await fixture(t);
  const real = join(root, 'real.json');
  await writeFile(real, '{}');
  await symlink(real, join(root, '.mcp.json'));
  await assert.rejects(installHosts({ hosts: ['claude'], root }), /symlinked/);
  await rm(join(root, '.mcp.json'));
  await writeFile(join(root, '.mcp.json'), '{ // comment\n "mcpServers": {}\n}');
  await assert.rejects(installHosts({ hosts: ['claude'], root }), /strict JSON/);
});

test('installer rejects a symlinked config directory beneath the selected root', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, join(root, '.codex'), 'dir');
  await assert.rejects(installHosts({ hosts: ['codex'], root }), /symlinked component/);
  await assert.rejects(readFile(join(outside, 'config.toml'), 'utf8'), { code: 'ENOENT' });
});

test('doctor inspection rejects provider-secret references in the Sigmora entry', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { sigmora: { type: 'http', url: 'https://api.sigmora.org/mcp', headers: { Authorization: 'Bearer ${OPENAI_API_KEY}' } } },
  }));
  const result = await inspectHost('claude', { root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /model-provider credential/);
});
