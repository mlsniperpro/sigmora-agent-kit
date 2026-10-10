import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { KIT_ROOT } from '../lib/config.js';

test('package allowlist includes all production components and excludes tests', async () => {
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  // plugin.json and mcp.json: the ChatGPT app ZIP rebuilds from the tarball.
  for (const required of ['.codex-plugin/', '.claude-plugin/', '.zcode-plugin/', '.mcp.json', 'plugin.json', 'mcp.json', 'assets/', 'bin/', 'lib/', 'skills/', 'rest-skill/', 'templates/', 'examples/', 'README.md']) {
    assert.ok(pkg.files.includes(required), required);
  }
  assert.equal(pkg.files.includes('test/'), false);
});

test('validation and package checks are dependency-free Node scripts', async () => {
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.test, /scripts\/validate\.mjs/);
  assert.match(pkg.scripts.test, /scripts\/package-check\.mjs/);
  assert.match(pkg.scripts['test:unit'], /^node --test /);
  assert.match(pkg.scripts.validate, /^node /);
  assert.match(pkg.scripts['package:check'], /^node /);
  assert.equal(pkg.prepack, undefined);
});

test('the kit, its skills and every native manifest are MIT, with the license text shipped (S-W5-12)', async () => {
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  for (const manifest of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.zcode-plugin/plugin.json']) {
    assert.equal(JSON.parse(await readFile(join(KIT_ROOT, manifest), 'utf8')).license, 'MIT', manifest);
  }
  const license = await readFile(join(KIT_ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) \d{4} Sigmora\n/);
  const skill = await readFile(join(KIT_ROOT, 'rest-skill/sigmora/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: sigmora\n[\s\S]*?\nlicense: MIT\n---\n/);
});

test('the scoped package publishes publicly, with provenance, from the public mirror (decision 8)', async () => {
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  // A scoped package is private on npm unless published with public access.
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.publishConfig?.provenance, true);
  // npm checks that the provenance source repository matches repository.url.
  assert.equal(pkg.repository?.url, 'git+https://github.com/mlsniperpro/sigmora-agent-kit.git');
  assert.equal(pkg.repository?.directory, undefined, 'the mirror root is the package');
});
