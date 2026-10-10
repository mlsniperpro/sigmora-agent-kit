// Derives the host manifests from the root plugin.json, the one manifest source
// (S-W5-07). The root plugin.json is the ChatGPT/agent-plugins manifest; the
// Codex, Claude Code and ZCode manifests and the Antigravity bundle take their
// identity (name, version, license, author) and the Codex interface its brand
// (display name, color, icons, policy URLs) from it. Host-specific copy
// (descriptions, default prompts, component paths) stays in each manifest.
//
//   node scripts/derive-manifests.mjs          rewrite the derived manifests
//   node scripts/derive-manifests.mjs --check  exit 1 when one has drifted
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ROOT_MANIFEST = 'plugin.json';
export const NATIVE_MANIFESTS = Object.freeze([
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.zcode-plugin/plugin.json',
]);
export const ANTIGRAVITY_MANIFEST = 'templates/antigravity/plugin.json';
export const DERIVED_MANIFESTS = Object.freeze([...NATIVE_MANIFESTS, ANTIGRAVITY_MANIFEST]);

// Root interface field -> Codex interface field, copied verbatim.
export const CODEX_INTERFACE_FROM_ROOT = Object.freeze({
  displayName: 'displayName',
  developerName: 'developerName',
  category: 'category',
  brandColor: 'brandColor',
  composerIcon: 'composerIcon',
  logo: 'logo',
  supportURL: 'supportURL',
  privacyPolicyURL: 'privacyPolicyURL',
  termsOfServiceURL: 'termsOfServiceURL',
});

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

function rootInterface(rootManifest) {
  const value = rootManifest?.extensions?.['com.openai']?.interface;
  if (!value || typeof value !== 'object') throw new Error('plugin.json has no extensions["com.openai"].interface');
  return value;
}

// Rebuilds `manifest` with `overrides` applied: existing keys keep their
// place, and keys the manifest lacks are inserted after `after` (or appended).
function withFields(manifest, overrides, after) {
  const missing = Object.entries(overrides).filter(([key]) => !Object.hasOwn(manifest, key));
  const result = {};
  for (const [key, value] of Object.entries(manifest)) {
    result[key] = Object.hasOwn(overrides, key) ? overrides[key] : value;
    if (key === after) for (const [newKey, newValue] of missing.splice(0)) result[newKey] = newValue;
  }
  for (const [newKey, newValue] of missing) result[newKey] = newValue;
  return result;
}

export function deriveManifest(path, current, rootManifest) {
  const identity = { name: rootManifest.name, version: rootManifest.version };
  if (path === ANTIGRAVITY_MANIFEST) return withFields(current, identity, 'name');
  const derived = withFields(current, {
    ...identity,
    author: structuredClone(rootManifest.author),
    license: rootManifest.license,
  }, 'name');
  if (path !== '.codex-plugin/plugin.json') return derived;
  const source = rootInterface(rootManifest);
  const brand = {};
  for (const [from, to] of Object.entries(CODEX_INTERFACE_FROM_ROOT)) {
    if (source[from] !== undefined) brand[to] = structuredClone(source[from]);
  }
  return { ...derived, interface: withFields(derived.interface ?? {}, brand) };
}

export function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Returns [{ path, expected, actual }] for every derived manifest.
export async function deriveAll(root = KIT_ROOT) {
  const rootManifest = await readJson(root, ROOT_MANIFEST);
  return Promise.all(DERIVED_MANIFESTS.map(async (path) => {
    const actual = await readFile(join(root, path), 'utf8');
    return { path, actual, expected: serialize(deriveManifest(path, JSON.parse(actual), rootManifest)) };
  }));
}

export async function driftedManifests(root = KIT_ROOT) {
  return (await deriveAll(root)).filter(({ actual, expected }) => actual !== expected).map(({ path }) => path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const results = await deriveAll();
  const drifted = results.filter(({ actual, expected }) => actual !== expected);
  if (check) {
    if (drifted.length) {
      process.stderr.write(`Derived manifests drifted from plugin.json: ${drifted.map(({ path }) => path).join(', ')}\nRun: node scripts/derive-manifests.mjs\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${results.length} derived manifests match plugin.json.\n`);
    }
  } else {
    for (const { path, expected } of drifted) await writeFile(join(KIT_ROOT, path), expected);
    process.stdout.write(`Rewrote ${drifted.length} of ${results.length} derived manifests from plugin.json.\n`);
  }
}
