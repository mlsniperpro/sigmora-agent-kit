import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAMES, HOSTS, KIT_ROOT, readHostTemplate } from '../lib/config.js';

const root = KIT_ROOT;
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function json(path) {
  try {
    return JSON.parse(await readFile(join(root, path), 'utf8'));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return null;
  }
}

async function exists(path) {
  try {
    await access(join(root, path), fsConstants.F_OK);
    return true;
  } catch {
    errors.push(`missing required file: ${path}`);
    return false;
  }
}

const packageJson = await json('package.json');
check(packageJson?.name === '@sigmora/agent-kit', 'package name must be @sigmora/agent-kit');
check(packageJson?.version === '0.1.0', 'package version must be 0.1.0');
check(packageJson?.type === 'module', 'package must be ESM');
check(packageJson?.engines?.node === '>=20', 'package must require Node >=20');
check(!packageJson?.dependencies || Object.keys(packageJson.dependencies).length === 0, 'package must have zero runtime dependencies');
check(packageJson?.bin?.sigmora === './bin/sigmora.js', 'package must expose the sigmora CLI');
for (const script of ['test', 'validate', 'package:check']) check(Boolean(packageJson?.scripts?.[script]), `missing package script: ${script}`);

for (const manifestPath of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.zcode-plugin/plugin.json']) {
  const manifest = await json(manifestPath);
  check(manifest?.name === 'sigmora', `${manifestPath}: name must be sigmora`);
  if (manifestPath === '.codex-plugin/plugin.json') {
    const escapedVersion = packageJson?.version?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    check(
      typeof escapedVersion === 'string' &&
        new RegExp(`^${escapedVersion}(?:\\+codex\\.[A-Za-z0-9][A-Za-z0-9.-]*)?$`).test(
          manifest?.version ?? '',
        ),
      `${manifestPath}: version must match package.json with only an optional Codex cachebuster`,
    );
  } else {
    check(manifest?.version === packageJson?.version, `${manifestPath}: version must match package.json`);
  }
  check(typeof manifest?.description === 'string' && manifest.description.length > 20, `${manifestPath}: description is missing`);
  check(manifest?.author?.name === 'Sigmora', `${manifestPath}: author.name must be Sigmora`);
  check(manifest?.homepage === 'https://docs.sigmora.org/mcp-server', `${manifestPath}: homepage must use the canonical MCP docs page`);
  const expectedMcpPath = {
    '.codex-plugin/plugin.json': './.mcp.json',
    '.claude-plugin/plugin.json': './templates/claude/.mcp.json',
    '.zcode-plugin/plugin.json': './templates/zcode/.mcp.json',
  }[manifestPath];
  check(manifest?.mcpServers === expectedMcpPath, `${manifestPath}: MCP companion path is invalid`);
}
const antigravityManifest = await json('templates/antigravity/plugin.json');
check(antigravityManifest?.name === 'sigmora', 'templates/antigravity/plugin.json: name must be sigmora');
check(typeof antigravityManifest?.description === 'string' && antigravityManifest.description.length > 40, 'templates/antigravity/plugin.json: description is missing');
check(/^https:\/\//.test(antigravityManifest?.icon ?? ''), 'templates/antigravity/plugin.json: icon must be an HTTPS URL (Antigravity stages only that directory)');

const codex = await json('.codex-plugin/plugin.json');
check(Array.isArray(codex?.interface?.defaultPrompt) && codex.interface.defaultPrompt.length <= 3, 'Codex defaultPrompt must contain at most three prompts');
for (const urlField of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
  check(/^https:\/\//.test(codex?.interface?.[urlField] ?? ''), `Codex ${urlField} must be HTTPS`);
}

const canonical = await json('.mcp.json');
check(canonical?.mcpServers?.sigmora?.url === 'https://api.sigmora.org/mcp', 'canonical MCP URL is invalid');
check(canonical?.mcpServers?.sigmora?.headers?.Authorization === 'Bearer ${SIGMORA_API_KEY}', 'canonical MCP auth must reference SIGMORA_API_KEY');
check(canonical?.mcpServers?.sigmora?.bearer_token_env_var === 'SIGMORA_API_KEY', 'canonical Codex MCP auth must expose bearer_token_env_var');

const codexMcpTemplate = await json('templates/codex/.mcp.json');
check(codexMcpTemplate?.mcpServers?.sigmora?.bearer_token_env_var === 'SIGMORA_API_KEY', 'Codex MCP template must expose bearer_token_env_var');
check(codexMcpTemplate?.mcpServers?.sigmora?.headers?.Authorization === 'Bearer ${SIGMORA_API_KEY}', 'Codex MCP template must retain compatibility authorization headers');

for (const host of HOST_NAMES) {
  const descriptor = HOSTS[host];
  check(await exists(descriptor.template), `${host}: template is missing`);
  try {
    const template = await readHostTemplate(host);
    const serialized = typeof template === 'string' ? template : JSON.stringify(template);
    check(serialized.includes('https://api.sigmora.org/mcp'), `${host}: template must use the canonical MCP endpoint`);
    if (descriptor.auth === 'environment') {
      check(serialized.includes('SIGMORA_API_KEY'), `${host}: environment-auth template must reference SIGMORA_API_KEY`);
    } else {
      check(!serialized.includes('SIGMORA_API_KEY') && !serialized.includes('Authorization'), `${host}: OAuth template must not embed an unsupported API-key header`);
    }
    check(!/\b(?:OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE|QWEN|KIMI|MOONSHOT|DEEPSEEK|GLM|CODEBUDDY|HEYGEN)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|CREDENTIAL)\b/i.test(serialized), `${host}: template references a model-provider credential`);
  } catch (error) {
    errors.push(`${host}: ${error.message}`);
  }
}

for (const required of [
  'bin/sigmora.js',
  'lib/cli.js',
  'lib/config.js',
  'lib/upload.js',
  'skills/sigmora-media/SKILL.md',
  'skills/sigmora-media/references/workflow-contract.md',
  'examples/local-upload.md',
  'examples/review-first-edit.md',
  'README.md',
]) await exists(required);

const cli = await readFile(join(root, 'bin/sigmora.js'), 'utf8');
check(cli.startsWith('#!/usr/bin/env node\n'), 'CLI must have a portable node shebang');
const cliMode = (await stat(join(root, 'bin/sigmora.js'))).mode;
check(Boolean(cliMode & 0o100), 'CLI must be executable');

const skill = await readFile(join(root, 'skills/sigmora-media/SKILL.md'), 'utf8');
check(skill.startsWith('---\nname: sigmora-media\n'), 'skill frontmatter/name is invalid');
check(skill.includes('projectId'), 'skill must enforce project-first behavior');
check(skill.includes('externalSessionId'), 'skill must supply the required external session identifier');
check(skill.includes('review'), 'skill must enforce review-first behavior');
check(skill.includes('idempotency'), 'skill must explain idempotent mutations');

const textFiles = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.zcode-plugin/plugin.json',
  '.mcp.json',
  'package.json',
  'README.md',
  'skills/sigmora-media/SKILL.md',
  'skills/sigmora-media/references/workflow-contract.md',
];
for (const path of textFiles) {
  const content = await readFile(join(root, path), 'utf8');
  check(!content.includes('[TODO:'), `${path}: unfinished scaffold placeholder`);
  check(!/\b(?:sk_live|sk_test|sk-proj)-[A-Za-z0-9_-]{12,}\b/.test(content), `${path}: appears to contain a live secret`);
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${packageJson.name}@${packageJson.version}: ${HOST_NAMES.length} host templates, 3 native manifests, zero runtime dependencies.\n`);
}
