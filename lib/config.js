import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOST_NAMES = Object.freeze([
  'codex',
  'claude',
  'opencode',
  'antigravity',
  'qwen',
  'kimi',
  'deepseek',
  'zcode',
  'codebuddy',
  'cursor',
  'gemini',
]);

export const HOSTS = Object.freeze({
  codex: {
    template: 'templates/codex/config.toml',
    projectPath: '.codex/config.toml',
    userPath: '.codex/config.toml',
    format: 'marked-toml',
    auth: 'environment',
  },
  claude: {
    template: 'templates/claude/.mcp.json',
    projectPath: '.mcp.json',
    userPath: '.claude.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'environment',
  },
  opencode: {
    template: 'templates/opencode/opencode.json',
    projectPath: 'opencode.json',
    userPath: '.config/opencode/opencode.json',
    serverPath: ['mcp', 'servers', 'sigmora'],
    auth: 'environment',
  },
  antigravity: {
    template: 'templates/antigravity/mcp_config.json',
    projectPath: '.agents/mcp_config.json',
    userPath: '.gemini/config/mcp_config.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'oauth',
  },
  qwen: {
    template: 'templates/qwen/settings.json',
    projectPath: '.qwen/settings.json',
    userPath: '.qwen/settings.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'oauth',
  },
  kimi: {
    template: 'templates/kimi/mcp.json',
    projectPath: '.kimi-code/mcp.json',
    userPath: '.kimi-code/mcp.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'environment',
  },
  deepseek: {
    template: 'templates/deepseek/cordis.patch.yml',
    projectPath: 'cordis.patch.yml',
    userPath: null,
    format: 'marked-yaml',
    auth: 'environment',
  },
  zcode: {
    template: 'templates/zcode/.mcp.json',
    projectPath: '.mcp.json',
    userPath: null,
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'environment',
  },
  codebuddy: {
    template: 'templates/codebuddy/.mcp.json',
    projectPath: '.mcp.json',
    userPath: '.codebuddy/.mcp.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'environment',
  },
  cursor: {
    template: 'templates/cursor/mcp.json',
    projectPath: '.cursor/mcp.json',
    userPath: '.cursor/mcp.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'oauth',
  },
  gemini: {
    template: 'templates/gemini/settings.json',
    projectPath: '.gemini/settings.json',
    userPath: '.gemini/settings.json',
    serverPath: ['mcpServers', 'sigmora'],
    auth: 'oauth',
  },
});

const YAML_START = '# BEGIN SIGMORA AGENT KIT';
const YAML_END = '# END SIGMORA AGENT KIT';
const TOML_START = '# BEGIN SIGMORA AGENT KIT';
const TOML_END = '# END SIGMORA AGENT KIT';
const FORBIDDEN_PROVIDER_SECRET = /\b(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE|QWEN|KIMI|MOONSHOT|DEEPSEEK|GLM|CODEBUDDY|HEYGEN)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|CREDENTIAL)\b/i;

function assertHost(host) {
  if (!Object.hasOwn(HOSTS, host)) {
    throw new Error(`Unsupported host "${host}". Choose one of: ${HOST_NAMES.join(', ')}.`);
  }
}

export function expandHosts(hosts = ['codex']) {
  const values = Array.isArray(hosts) ? hosts : [hosts];
  const expanded = values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  const unique = expanded.includes('all') ? [...HOST_NAMES] : [...new Set(expanded)];
  for (const host of unique) assertHost(host);
  return unique;
}

export function resolveConfigPath(host, { scope = 'project', root = process.cwd(), home = homedir() } = {}) {
  assertHost(host);
  if (!['project', 'user'].includes(scope)) throw new Error('Scope must be "project" or "user".');
  const relativePath = scope === 'project' ? HOSTS[host].projectPath : HOSTS[host].userPath;
  if (!relativePath) throw new Error(`${host} does not have a safe ${scope}-scope config target; use its native plugin flow.`);
  const base = resolve(scope === 'project' ? root : home);
  const target = resolve(base, relativePath);
  assertWithinBase(base, target);
  return target;
}

function configBase({ scope = 'project', root = process.cwd(), home = homedir() } = {}) {
  return resolve(scope === 'project' ? root : home);
}

function assertWithinBase(base, target) {
  const fromBase = relative(base, target);
  if (!fromBase || fromBase === '..' || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new Error(`Refusing config target outside the selected root/home boundary: ${target}`);
  }
  return fromBase;
}

async function assertSafeConfigPath(base, target) {
  const fromBase = assertWithinBase(base, target);
  let cursor = base;
  for (const segment of fromBase.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing config path with symlinked component: ${cursor}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

export async function readHostTemplate(host) {
  assertHost(host);
  const descriptor = HOSTS[host];
  const raw = await readFile(join(KIT_ROOT, descriptor.template), 'utf8');
  return descriptor.format?.startsWith('marked-') ? raw.trim() : parseJson(raw, descriptor.template);
}

function parseJson(raw, label) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    throw new Error(`Cannot safely merge ${label}: expected strict JSON (${error.message}). Remove comments/trailing commas or use the host's native config command.`);
  }
}

function getAt(object, path) {
  let cursor = object;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function setAt(object, path, value) {
  let cursor = object;
  for (const segment of path.slice(0, -1)) {
    if (!Object.hasOwn(cursor, segment)) cursor[segment] = {};
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      throw new Error(`Cannot merge Sigmora configuration: "${segment}" is not an object.`);
    }
    cursor = cursor[segment];
  }
  cursor[path.at(-1)] = structuredClone(value);
}

function deleteAt(object, path) {
  const parent = getAt(object, path.slice(0, -1));
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
  return delete parent[path.at(-1)];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function equalConfig(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertNotSymlink(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to modify symlinked config: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function backupFile(path, now, base) {
  await assertSafeConfigPath(base, path);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index ? `-${index}` : '';
    const backup = `${path}.bak.${backupStamp(now)}${suffix}`;
    try {
      await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
      await chmod(backup, 0o600);
      return backup;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not allocate a unique backup name for ${path}.`);
}

async function atomicWrite(path, content, base) {
  await assertSafeConfigPath(base, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeConfigPath(base, path);
  const temporary = join(dirname(path), `.${basename(path)}.sigmora-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await assertSafeConfigPath(base, path);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function jsonOutput(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNoProviderSecretReference(value, label) {
  const serialized = JSON.stringify(value);
  if (FORBIDDEN_PROVIDER_SECRET.test(serialized)) {
    throw new Error(`${label} references a model-provider credential. Sigmora configuration may reference only SIGMORA_API_KEY.`);
  }
}

async function installJson(host, path, descriptor, template, { dryRun, force, now, base }) {
  await assertSafeConfigPath(base, path);
  const exists = await pathExists(path);
  await assertNotSymlink(path);
  const target = exists ? parseJson(await readFile(path, 'utf8'), path) : {};
  const desired = getAt(template, descriptor.serverPath);
  assertNoProviderSecretReference(desired, `${host} template`);
  const current = getAt(target, descriptor.serverPath);
  if (current !== undefined && equalConfig(current, desired)) {
    return { host, path, action: 'unchanged', backup: null };
  }
  if (current !== undefined && !force) {
    throw new Error(`${host} already has a different Sigmora entry at ${path}. Re-run with --force only after reviewing it.`);
  }
  setAt(target, descriptor.serverPath, desired);
  if (template.$schema && !target.$schema) target.$schema = template.$schema;
  if (dryRun) return { host, path, action: exists ? 'would-update' : 'would-create', backup: null };
  const backup = exists ? await backupFile(path, now, base) : null;
  await atomicWrite(path, jsonOutput(target), base);
  return { host, path, action: exists ? 'updated' : 'created', backup };
}

function extractMarkedBlock(raw) {
  const start = raw.indexOf(YAML_START);
  const end = raw.indexOf(YAML_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end === -1 || end < start || raw.indexOf(YAML_START, start + 1) !== -1 || raw.indexOf(YAML_END, end + 1) !== -1) {
    throw new Error('DeepSeek Cordis config has malformed or duplicate Sigmora marker blocks.');
  }
  return { start, end: end + YAML_END.length, text: raw.slice(start, end + YAML_END.length).trim() };
}

function extractTomlBlock(raw) {
  const start = raw.indexOf(TOML_START);
  const end = raw.indexOf(TOML_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end === -1 || end < start || raw.indexOf(TOML_START, start + 1) !== -1 || raw.indexOf(TOML_END, end + 1) !== -1) {
    throw new Error('Codex config has malformed or duplicate Sigmora marker blocks.');
  }
  return { start, end: end + TOML_END.length, text: raw.slice(start, end + TOML_END.length).trim() };
}

async function installMarkedToml(host, path, template, { dryRun, force, now, base }) {
  await assertSafeConfigPath(base, path);
  const exists = await pathExists(path);
  await assertNotSymlink(path);
  const raw = exists ? await readFile(path, 'utf8') : '';
  const marked = extractTomlBlock(raw);
  if (marked?.text === template) return { host, path, action: 'unchanged', backup: null };
  if (marked && !force) throw new Error(`codex already has a different Sigmora marker block at ${path}; review it before using --force.`);
  if (!marked && /^\s*\[mcp_servers\.sigmora\]\s*$/m.test(raw)) {
    throw new Error(`Codex already has an unmanaged [mcp_servers.sigmora] table at ${path}; merge it manually to avoid duplicate TOML tables.`);
  }
  const without = marked ? `${raw.slice(0, marked.start)}${raw.slice(marked.end)}`.trim() : raw.trim();
  const content = `${without ? `${without}\n\n` : ''}${template}\n`;
  if (dryRun) return { host, path, action: exists ? 'would-update' : 'would-create', backup: null };
  const backup = exists ? await backupFile(path, now, base) : null;
  await atomicWrite(path, content, base);
  return { host, path, action: exists ? 'updated' : 'created', backup };
}

async function installMarkedYaml(host, path, template, { dryRun, force, now, base }) {
  await assertSafeConfigPath(base, path);
  const exists = await pathExists(path);
  await assertNotSymlink(path);
  const raw = exists ? await readFile(path, 'utf8') : '';
  const marked = extractMarkedBlock(raw);
  if (marked?.text === template) return { host, path, action: 'unchanged', backup: null };
  if (marked && !force) throw new Error(`deepseek already has a different Sigmora marker block at ${path}; review it before using --force.`);
  const without = marked ? `${raw.slice(0, marked.start)}${raw.slice(marked.end)}`.trim() : raw.trim();
  if (!marked && without && !/^(?:---\s*)?(?:#.*\n\s*)*-\s/m.test(without)) {
    throw new Error(`Cannot safely append a Cordis list row to ${path}; use the template manually.`);
  }
  const content = `${without ? `${without}\n\n` : ''}${template}\n`;
  if (dryRun) return { host, path, action: exists ? 'would-update' : 'would-create', backup: null };
  const backup = exists ? await backupFile(path, now, base) : null;
  await atomicWrite(path, content, base);
  return { host, path, action: exists ? 'updated' : 'created', backup };
}

export async function installHosts({ hosts = ['codex'], scope = 'project', root, home, dryRun = false, force = false, now = new Date() } = {}) {
  const base = configBase({ scope, root, home });
  const operations = await Promise.all(expandHosts(hosts).map(async (host) => ({
    host,
    descriptor: HOSTS[host],
    path: resolveConfigPath(host, { scope, root, home }),
    template: await readHostTemplate(host),
  })));
  const results = [];
  for (const { host, descriptor, path, template } of operations) {
    results.push(descriptor.format === 'marked-yaml'
      ? await installMarkedYaml(host, path, template, { dryRun, force, now, base })
      : descriptor.format === 'marked-toml'
        ? await installMarkedToml(host, path, template, { dryRun, force, now, base })
        : await installJson(host, path, descriptor, template, { dryRun, force, now, base }));
  }
  return results;
}

async function uninstallJson(host, path, descriptor, template, { dryRun, force, now, base }) {
  await assertSafeConfigPath(base, path);
  if (!(await pathExists(path))) return { host, path, action: 'unchanged', backup: null };
  await assertNotSymlink(path);
  const target = parseJson(await readFile(path, 'utf8'), path);
  const current = getAt(target, descriptor.serverPath);
  if (current === undefined) return { host, path, action: 'unchanged', backup: null };
  const desired = getAt(template, descriptor.serverPath);
  if (!equalConfig(current, desired) && !force) {
    throw new Error(`${host}'s Sigmora entry changed after installation. Refusing to remove it without --force.`);
  }
  deleteAt(target, descriptor.serverPath);
  if (dryRun) return { host, path, action: 'would-update', backup: null };
  const backup = await backupFile(path, now, base);
  await atomicWrite(path, jsonOutput(target), base);
  return { host, path, action: 'updated', backup };
}

async function uninstallMarkedYaml(host, path, { dryRun, now, base }) {
  await assertSafeConfigPath(base, path);
  if (!(await pathExists(path))) return { host, path, action: 'unchanged', backup: null };
  await assertNotSymlink(path);
  const raw = await readFile(path, 'utf8');
  const marked = extractMarkedBlock(raw);
  if (!marked) return { host, path, action: 'unchanged', backup: null };
  const without = `${raw.slice(0, marked.start)}${raw.slice(marked.end)}`.trim();
  const content = without ? `${without}\n` : '';
  if (dryRun) return { host, path, action: 'would-update', backup: null };
  const backup = await backupFile(path, now, base);
  await atomicWrite(path, content, base);
  return { host, path, action: 'updated', backup };
}

async function uninstallMarkedToml(host, path, { dryRun, now, base }) {
  await assertSafeConfigPath(base, path);
  if (!(await pathExists(path))) return { host, path, action: 'unchanged', backup: null };
  await assertNotSymlink(path);
  const raw = await readFile(path, 'utf8');
  const marked = extractTomlBlock(raw);
  if (!marked) return { host, path, action: 'unchanged', backup: null };
  const without = `${raw.slice(0, marked.start)}${raw.slice(marked.end)}`.trim();
  const content = without ? `${without}\n` : '';
  if (dryRun) return { host, path, action: 'would-update', backup: null };
  const backup = await backupFile(path, now, base);
  await atomicWrite(path, content, base);
  return { host, path, action: 'updated', backup };
}

export async function uninstallHosts({ hosts = ['codex'], scope = 'project', root, home, dryRun = false, force = false, now = new Date() } = {}) {
  const base = configBase({ scope, root, home });
  const operations = await Promise.all(expandHosts(hosts).map(async (host) => ({
    host,
    descriptor: HOSTS[host],
    path: resolveConfigPath(host, { scope, root, home }),
    template: await readHostTemplate(host),
  })));
  const results = [];
  for (const { host, descriptor, path, template } of operations) {
    results.push(descriptor.format === 'marked-yaml'
      ? await uninstallMarkedYaml(host, path, { dryRun, now, base })
      : descriptor.format === 'marked-toml'
        ? await uninstallMarkedToml(host, path, { dryRun, now, base })
        : await uninstallJson(host, path, descriptor, template, { dryRun, force, now, base }));
  }
  return results;
}

export async function inspectHost(host, { scope = 'project', root, home } = {}) {
  const descriptor = HOSTS[host];
  const path = resolveConfigPath(host, { scope, root, home });
  try {
    await assertSafeConfigPath(configBase({ scope, root, home }), path);
    if (!(await pathExists(path))) return { host, path, ok: false, status: 'missing', message: 'config file not found' };
    const template = await readHostTemplate(host);
    if (descriptor.format === 'marked-yaml') {
      const raw = await readFile(path, 'utf8');
      const marked = extractMarkedBlock(raw);
      return marked?.text === template
        ? { host, path, ok: true, status: 'configured', message: 'Sigmora Cordis block is current' }
        : { host, path, ok: false, status: marked ? 'drifted' : 'missing-entry', message: 'Sigmora Cordis block is absent or changed' };
    }
    if (descriptor.format === 'marked-toml') {
      const raw = await readFile(path, 'utf8');
      const marked = extractTomlBlock(raw);
      return marked?.text === template
        ? { host, path, ok: true, status: 'configured', message: 'Sigmora Codex MCP block is current' }
        : { host, path, ok: false, status: marked ? 'drifted' : 'missing-entry', message: 'Sigmora Codex MCP block is absent or changed' };
    }
    const target = parseJson(await readFile(path, 'utf8'), path);
    const current = getAt(target, descriptor.serverPath);
    if (current === undefined) return { host, path, ok: false, status: 'missing-entry', message: 'Sigmora server entry not found' };
    assertNoProviderSecretReference(current, `${host} Sigmora entry`);
    const desired = getAt(template, descriptor.serverPath);
    return equalConfig(current, desired)
      ? { host, path, ok: true, status: 'configured', message: 'Sigmora server entry is current' }
      : { host, path, ok: false, status: 'drifted', message: 'Sigmora server entry differs from the current template' };
  } catch (error) {
    return { host, path, ok: false, status: 'invalid', message: error.message };
  }
}
