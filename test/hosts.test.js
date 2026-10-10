// Static install tier (decision 13): every native manifest and marketplace is
// walked the way its host loads it, and `install` / `doctor` / `uninstall` run
// for all 11 hosts against temporary project and home directories. No network:
// the OAuth doctor reads a stubbed protected-resource document. The network
// tier (`sigmora doctor --network` with SIGMORA_CERTIFICATION_API_KEY) and the
// real-host tier are founder steps.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { doctor, VERSION as CLI_VERSION } from '../lib/cli.js';
import { HOST_NAMES, HOSTS, KIT_ROOT, installHosts, uninstallHosts } from '../lib/config.js';
import { DERIVED_MANIFESTS, NATIVE_MANIFESTS, driftedManifests } from '../scripts/derive-manifests.mjs';

const MCP_URL = 'https://api.sigmora.org/mcp';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const kitJson = (path) => readJson(join(KIT_ROOT, path));

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function assertInside(base, target, label) {
  const fromBase = relative(base, target);
  assert.ok(fromBase === '' || (!fromBase.startsWith(`..${sep}`) && fromBase !== '..'), `${label} escapes ${base}`);
}

// A host loads a component path relative to the plugin root: the directory
// that holds `.<host>-plugin/`, or the manifest's own directory for a bundle
// whose plugin.json sits at its root.
function bundleRootOf(manifestPath) {
  const directory = dirname(manifestPath);
  return /(^|\/)\.[a-z]+-plugin$/.test(directory) ? dirname(directory) : directory;
}

async function assertSkillsDirectory(base, skillsPath, label) {
  const directory = resolve(base, skillsPath);
  assertInside(base, directory, label);
  assert.ok(await isDirectory(directory), `${label}: skills path ${skillsPath} does not resolve from ${base}`);
  const skills = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = join(directory, entry.name, 'SKILL.md');
    if (!(await isFile(skill))) continue;
    const text = await readFile(skill, 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${entry.name}\\n`), `${label}: ${entry.name}/SKILL.md frontmatter name`);
    skills.push(entry.name);
  }
  assert.ok(skills.length > 0, `${label}: ${skillsPath} holds no SKILL.md`);
  return skills;
}

async function assertMcpFile(base, mcpPath, label) {
  const file = resolve(base, mcpPath);
  assertInside(base, file, label);
  assert.ok(await isFile(file), `${label}: mcpServers path ${mcpPath} does not resolve from ${base}`);
  const config = await readJson(file);
  const server = config.mcpServers?.sigmora;
  assert.ok(server, `${label}: ${mcpPath} has no mcpServers.sigmora`);
  assert.equal(server.url ?? server.serverUrl, MCP_URL, `${label}: MCP URL`);
}

async function listPluginManifests(directory = KIT_ROOT) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listPluginManifests(path));
    else if (entry.name === 'plugin.json') found.push(relative(KIT_ROOT, path).split(sep).join('/'));
  }
  return found.sort();
}

test('every plugin.json in the kit is a known bundle whose paths resolve from its own root', async () => {
  const manifests = await listPluginManifests();
  for (const path of manifests) {
    const manifest = await kitJson(path);
    const base = join(KIT_ROOT, bundleRootOf(path));
    assert.equal(manifest.name, 'sigmora', path);
    if (manifest.skills !== undefined) await assertSkillsDirectory(base, manifest.skills, path);
    if (typeof manifest.mcpServers === 'string') await assertMcpFile(base, manifest.mcpServers, path);
  }
  assert.deepEqual(manifests, [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.zcode-plugin/plugin.json',
    'plugin.json',
    'templates/antigravity/plugin.json',
  ]);
});

test('Codex, Claude Code and ZCode load skills, MCP and icons from the plugin root', async () => {
  for (const path of NATIVE_MANIFESTS) {
    const manifest = await kitJson(path);
    assert.equal(typeof manifest.skills, 'string', path);
    assert.equal(typeof manifest.mcpServers, 'string', path);
    const skills = await assertSkillsDirectory(KIT_ROOT, manifest.skills, path);
    for (const expected of ['sigmora-media', 'sigmora']) assert.ok(skills.includes(expected), `${path}: ${expected}`);
    await assertMcpFile(KIT_ROOT, manifest.mcpServers, path);
  }
  const codex = await kitJson('.codex-plugin/plugin.json');
  for (const field of ['composerIcon', 'logo']) {
    const icon = codex.interface[field];
    assert.match(icon ?? '', /^\.\//, `Codex interface.${field}`);
    assert.ok(await isFile(resolve(KIT_ROOT, icon)), `Codex interface.${field} ${icon} does not resolve`);
  }
  const root = await kitJson('plugin.json');
  const rootInterface = root.extensions['com.openai'].interface;
  for (const field of ['composerIcon', 'logo']) {
    assert.ok(await isFile(resolve(KIT_ROOT, rootInterface[field])), `plugin.json ${field}`);
  }
  assert.equal((await kitJson('mcp.json')).mcpServers.sigmora.url, MCP_URL);
});

test('the Codex interface and every host manifest derive from the root plugin.json (S-W5-07)', async () => {
  const root = await kitJson('plugin.json');
  const rootInterface = root.extensions['com.openai'].interface;
  const codex = await kitJson('.codex-plugin/plugin.json');
  assert.equal(codex.name, root.name);
  assert.equal(codex.interface.displayName, rootInterface.displayName);
  assert.equal(codex.interface.brandColor, rootInterface.brandColor);
  assert.equal(codex.interface.composerIcon, rootInterface.composerIcon);
  assert.equal(codex.interface.logo, rootInterface.logo);
  for (const path of DERIVED_MANIFESTS) {
    const manifest = await kitJson(path);
    assert.equal(manifest.name, root.name, path);
    assert.equal(manifest.version, root.version, `${path} version`);
  }
  assert.deepEqual(await driftedManifests(), [], 'run node scripts/derive-manifests.mjs');
});

test('the npm package and the CLI carry the root manifest version', async () => {
  const root = await kitJson('plugin.json');
  const pkg = await kitJson('package.json');
  assert.equal(pkg.version, root.version, 'package.json version must equal plugin.json version');
  assert.equal(CLI_VERSION, pkg.version, 'lib/cli.js VERSION must equal package.json version');
});

test('the Antigravity bundle is complete: description, icon and its mcp_config.json', async () => {
  const manifest = await kitJson('templates/antigravity/plugin.json');
  assert.equal(manifest.name, 'sigmora');
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 40, 'description');
  // Antigravity stages only this directory, so the icon is the public copy of
  // assets/icon.png (apps/web/public/icon-512.png), not a path into the kit.
  assert.equal(manifest.icon, 'https://sigmora.org/icon-512.png');
  const config = await kitJson('templates/antigravity/mcp_config.json');
  assert.deepEqual(config, { mcpServers: { sigmora: { serverUrl: MCP_URL } } });
});

// --- marketplaces -----------------------------------------------------------

// https://code.claude.com/docs/en/plugins/marketplace-reference
const CLAUDE_RESERVED = new Set([
  'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'anthropic-marketplace',
  'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills', 'life-sciences', 'knowledge-work-plugins',
  'claude-for-legal', 'claude-for-financial-services', 'financial-services-plugins', 'first-party-plugins',
  'claude-tag-plugins', 'claude-community', 'claude-plugins-community', 'healthcare',
  'anthropic-plugin-directory', 'claude-plugin-directory', 'inline', 'builtin', 'skills-dir', 'synced',
  'claude-plugin-test', 'npm', 'pip', 'uv', 'cargo', 'github', 'gh',
]);
const CLAUDE_TOP_KEYS = new Set([
  '$schema', 'name', 'owner', 'plugins', 'description', 'version', 'metadata', 'forceRemoveDeletedPlugins',
  'allowCrossMarketplaceDependenciesOn', 'renames',
]);
const CLAUDE_ENTRY_KEYS = new Set([
  'name', 'source', 'description', 'version', 'category', 'tags', 'strict', 'relevance', 'dependencies',
  'defaultEnabled', 'displayName', 'metadata', 'author', 'homepage', 'repository', 'license', 'keywords',
]);
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertRelativeSource(path, label) {
  assert.equal(typeof path, 'string', `${label}: source path`);
  assert.ok(path === '.' || path.startsWith('./'), `${label}: source must start with "./"`);
  assert.ok(!path.split('/').includes('..'), `${label}: source contains ".."`);
  assert.ok(!path.includes('\\'), `${label}: source contains a backslash`);
}

// Walks a Claude Code marketplace the way `claude plugin validate` and
// `claude plugin install` do; returns the resolved plugin directories.
async function walkClaudeMarketplace(marketplaceRoot) {
  const file = join(marketplaceRoot, '.claude-plugin/marketplace.json');
  assert.ok(await isFile(file), `no Claude Code marketplace at ${file}`);
  const marketplace = await readJson(file);
  for (const key of Object.keys(marketplace)) assert.ok(CLAUDE_TOP_KEYS.has(key), `unknown marketplace key ${key}`);
  assert.match(marketplace.name ?? '', PLUGIN_ID);
  assert.ok(!marketplace.name.includes('..') && !CLAUDE_RESERVED.has(marketplace.name.toLowerCase()), 'reserved name');
  assert.ok(!marketplace.name.startsWith('claudeai-'), 'claudeai- prefix is reserved');
  assert.ok(typeof marketplace.owner?.name === 'string' && marketplace.owner.name.length > 0, 'owner.name');
  assert.ok(typeof marketplace.description === 'string' && marketplace.description.length > 0, 'description');
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'plugins');
  const names = new Set();
  const resolved = [];
  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `plugins[${index}]`;
    for (const key of Object.keys(entry)) assert.ok(CLAUDE_ENTRY_KEYS.has(key), `${label}: unknown key ${key}`);
    assert.match(entry.name ?? '', PLUGIN_ID, label);
    assert.ok(!names.has(entry.name), `${label}: duplicate name`);
    names.add(entry.name);
    assertRelativeSource(entry.source, label);
    const directory = resolve(marketplaceRoot, entry.source);
    assertInside(marketplaceRoot, directory, label);
    const manifest = await readJson(join(directory, '.claude-plugin/plugin.json'));
    assert.equal(manifest.name, entry.name, `${label}: entry name must equal the manifest name`);
    assert.equal(entry.version, undefined, `${label}: plugin.json owns the version`);
    resolved.push({ name: entry.name, directory, manifest });
  }
  return { marketplace, resolved };
}

const CODEX_INSTALLATION = new Set(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']);
const CODEX_AUTHENTICATION = new Set(['ON_INSTALL', 'ON_USE']);

// Walks a Codex (.agents) marketplace: local sources resolve from the
// marketplace root, the directory that holds `.agents/`.
async function walkCodexMarketplace(marketplaceRoot) {
  const file = join(marketplaceRoot, '.agents/plugins/marketplace.json');
  assert.ok(await isFile(file), `no Codex marketplace at ${file}`);
  const marketplace = await readJson(file);
  assert.match(marketplace.name ?? '', PLUGIN_ID);
  assert.ok(typeof marketplace.interface?.displayName === 'string', 'interface.displayName');
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'plugins');
  const resolved = [];
  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `plugins[${index}]`;
    assert.match(entry.name ?? '', PLUGIN_ID, label);
    assert.equal(entry.source?.source, 'local', `${label}: source.source`);
    assertRelativeSource(entry.source.path, label);
    assert.ok(CODEX_INSTALLATION.has(entry.policy?.installation), `${label}: policy.installation`);
    assert.ok(CODEX_AUTHENTICATION.has(entry.policy?.authentication), `${label}: policy.authentication`);
    assert.ok(typeof entry.category === 'string' && entry.category.length > 0, `${label}: category`);
    const directory = resolve(marketplaceRoot, entry.source.path);
    assertInside(marketplaceRoot, directory, label);
    const manifest = await readJson(join(directory, '.codex-plugin/plugin.json'));
    assert.equal(manifest.name, entry.name, `${label}: entry name must equal the manifest name`);
    resolved.push({ name: entry.name, directory, manifest });
  }
  return { marketplace, resolved };
}

test('the kit is a Claude Code marketplace whose sigmora entry is the kit itself (decision 9)', async () => {
  const { marketplace, resolved } = await walkClaudeMarketplace(KIT_ROOT);
  assert.equal(marketplace.name, 'sigmora');
  assert.equal(marketplace.owner.name, 'Sigmora');
  assert.deepEqual(resolved.map(({ name }) => name), ['sigmora']);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(resolve(resolved[0].directory), resolve(KIT_ROOT));
});

test('the kit is a Codex marketplace whose sigmora entry is the kit itself (decision 9)', async () => {
  const { marketplace, resolved } = await walkCodexMarketplace(KIT_ROOT);
  assert.equal(marketplace.name, 'sigmora');
  assert.deepEqual(resolved.map(({ name }) => name), ['sigmora']);
  assert.equal(marketplace.plugins[0].source.path, './');
  assert.equal(resolve(resolved[0].directory), resolve(KIT_ROOT));
});

test('in the monorepo, the local-development personal marketplace still resolves to the kit', {
  skip: !existsSync(resolve(KIT_ROOT, '../../pnpm-workspace.yaml')) && 'public mirror: no monorepo marketplace',
}, async () => {
  const repositoryRoot = resolve(KIT_ROOT, '../..');
  const { marketplace, resolved } = await walkCodexMarketplace(repositoryRoot);
  assert.equal(marketplace.name, 'personal');
  assert.equal(resolve(resolved[0].directory), resolve(KIT_ROOT));
});

// --- install / doctor / uninstall for every host ------------------------------

// Unrelated content a person may already have in each host's config file; the
// install must keep it and the uninstall must give it back unchanged.
function seedFor(host) {
  const descriptor = HOSTS[host];
  if (descriptor.format === 'marked-toml') return 'model = "gpt-example"\n\n[mcp_servers.other]\ncommand = "other-server"\n';
  if (descriptor.format === 'marked-yaml') return '- id: existing\n  name: existing-plugin\n';
  const [top] = descriptor.serverPath;
  const seeded = { theme: 'dark' };
  seeded[top] = descriptor.serverPath.length === 3 ? { [descriptor.serverPath[1]]: { other: { url: 'https://other.example/mcp' } } } : { other: { url: 'https://other.example/mcp' } };
  return `${JSON.stringify(seeded, null, 2)}\n`;
}

// Parses the managed TOML block strictly enough to reject anything a TOML
// reader would: one table header, then `key = value` lines whose values are
// TOML basic strings, integers or booleans.
function parseTomlBlock(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.equal(lines[0], '[mcp_servers.sigmora]');
  const table = {};
  for (const line of lines.slice(1)) {
    const match = /^([A-Za-z0-9_-]+) = (.+)$/.exec(line);
    assert.ok(match, `not a TOML key/value line: ${line}`);
    assert.ok(!Object.hasOwn(table, match[1]), `duplicate TOML key ${match[1]}`);
    assert.match(match[2], /^(?:"(?:[^"\\]|\\.)*"|-?\d+|true|false)$/, `unsupported TOML value: ${line}`);
    table[match[1]] = JSON.parse(match[2]);
  }
  return table;
}

// Parses the managed Cordis YAML block: one list row whose nested mappings use
// two-space indentation, as the DeepSeek Harness plugin list expects.
function parseCordisRow(text) {
  const lines = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.match(lines[0], /^- id: mcp-sigmora$/);
  const row = { id: 'mcp-sigmora' };
  const stack = [{ indent: 0, value: row }];
  for (const line of lines.slice(1)) {
    const match = /^( +)([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    assert.ok(match, `not a YAML mapping line: ${line}`);
    const indent = match[1].length;
    assert.equal(indent % 2, 0, `odd YAML indentation: ${line}`);
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    assert.equal(indent, stack.at(-1).indent + 2, `YAML indentation jumps: ${line}`);
    const parent = stack.at(-1).value;
    assert.ok(!Object.hasOwn(parent, match[2]), `duplicate YAML key ${match[2]}`);
    if (match[3] === undefined) {
      parent[match[2]] = {};
      stack.push({ indent, value: parent[match[2]] });
    } else {
      parent[match[2]] = match[3].replace(/^'(.*)'$/, '$1');
    }
  }
  return row;
}

function sigmoraEntry(host, text) {
  const descriptor = HOSTS[host];
  if (descriptor.format === 'marked-toml') {
    const start = text.indexOf('# BEGIN SIGMORA AGENT KIT');
    const end = text.indexOf('# END SIGMORA AGENT KIT');
    assert.ok(start >= 0 && end > start, 'Codex marker block');
    return parseTomlBlock(text.slice(start, end));
  }
  if (descriptor.format === 'marked-yaml') {
    const start = text.indexOf('# BEGIN SIGMORA AGENT KIT');
    const end = text.indexOf('# END SIGMORA AGENT KIT');
    assert.ok(start >= 0 && end > start, 'Cordis marker block');
    return parseCordisRow(text.slice(start, end));
  }
  return descriptor.serverPath.reduce((cursor, key) => cursor?.[key], JSON.parse(text));
}

function assertClean(host, original, after) {
  if (HOSTS[host].format) {
    assert.equal(after, original ?? '', `${host}: uninstall must restore the file byte for byte`);
    return;
  }
  assert.deepEqual(JSON.parse(after), original === null ? {} : JSON.parse(original), `${host}: uninstall must leave only the config that was there`);
}

const OAUTH_METADATA_FETCH = async (url) => {
  assert.equal(String(url), 'https://api.sigmora.org/.well-known/oauth-protected-resource/mcp');
  return new Response(JSON.stringify({ resource: MCP_URL, authorization_servers: ['https://sigmora.org'] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function walkHost(t, host, { scope, seeded }) {
  const base = await mkdtemp(join(tmpdir(), `sigmora-host-${host}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const where = scope === 'project' ? { root: base, home: join(base, 'unused-home') } : { root: join(base, 'unused-root'), home: base };
  const relativePath = scope === 'project' ? HOSTS[host].projectPath : HOSTS[host].userPath;
  const path = join(base, relativePath);
  const original = seeded ? seedFor(host) : null;
  if (original !== null) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, original);
  }

  const [installed] = await installHosts({ hosts: [host], scope, ...where });
  assert.equal(installed.path, path, `${host}: install target`);
  assert.equal(installed.action, seeded ? 'updated' : 'created', host);
  const text = await readFile(path, 'utf8');
  const entry = sigmoraEntry(host, text);
  assert.ok(entry, `${host}: installed file has no Sigmora entry`);
  assert.ok(JSON.stringify(entry).includes(MCP_URL), `${host}: Sigmora entry points at ${MCP_URL}`);
  if (seeded && !HOSTS[host].format) assert.equal(JSON.parse(text).theme, 'dark', `${host}: unrelated keys kept`);
  if (seeded && HOSTS[host].format) assert.ok(text.startsWith(original.trim()), `${host}: existing text kept`);

  const oauth = HOSTS[host].auth === 'oauth';
  const report = await doctor({
    hosts: [host],
    scope,
    ...where,
    network: oauth,
    env: { SIGMORA_API_KEY: 'sk_static_tier_placeholder' },
    fetchImpl: oauth ? OAUTH_METADATA_FETCH : async () => { throw new Error('the static tier makes no network calls'); },
  });
  assert.equal(report.ok, true, `${host}: doctor ${JSON.stringify(report.checks.filter((check) => !check.ok))}`);
  assert.equal(report.checks.find((check) => check.name === 'configuration').status, 'configured', host);

  const [removed] = await uninstallHosts({ hosts: [host], scope, ...where });
  assert.equal(removed.action, 'updated', host);
  assertClean(host, original, await readFile(path, 'utf8'));
  const after = await doctor({ hosts: [host], scope, ...where, env: { SIGMORA_API_KEY: 'sk_static_tier_placeholder' } });
  assert.equal(after.ok, false, `${host}: doctor must fail once Sigmora is uninstalled`);
}

for (const host of HOST_NAMES) {
  test(`${host}: install writes a parseable block, doctor passes, uninstall leaves the file clean`, async (t) => {
    await walkHost(t, host, { scope: 'project', seeded: false });
    await walkHost(t, host, { scope: 'project', seeded: true });
    if (HOSTS[host].userPath) await walkHost(t, host, { scope: 'user', seeded: true });
  });
}

test('the static tier covers all 11 hosts', () => {
  assert.equal(HOST_NAMES.length, 11);
});
