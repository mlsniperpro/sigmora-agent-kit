import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { KIT_ROOT } from '../lib/config.js';
import { DERIVED_MANIFESTS, ROOT_MANIFEST } from '../scripts/derive-manifests.mjs';
import { versionAlignmentErrors } from '../scripts/validate.mjs';

// A copy of the kit's version-bearing files, with the root manifest's version
// optionally changed.
async function fixture(rootVersion) {
  const dir = await mkdtemp(join(tmpdir(), 'sigmora-validate-'));
  for (const path of ['package.json', ROOT_MANIFEST, ...DERIVED_MANIFESTS]) {
    const json = JSON.parse(await readFile(join(KIT_ROOT, path), 'utf8'));
    if (path === ROOT_MANIFEST && rootVersion) json.version = rootVersion;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), `${JSON.stringify(json, null, 2)}\n`);
  }
  return dir;
}

test('validate: the kit itself is version-aligned', async () => {
  assert.deepEqual(await versionAlignmentErrors(KIT_ROOT), []);
});

test('validate: a root plugin.json whose version differs from package.json fails (W5R1-DUP-03)', async () => {
  const dir = await fixture('9.9.9');
  try {
    const { version } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(await versionAlignmentErrors(dir), [
      `plugin.json: version 9.9.9 must equal package.json version ${version}`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
