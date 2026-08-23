import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { KIT_ROOT } from '../lib/config.js';

test('package allowlist includes all production components and excludes tests', async () => {
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  for (const required of ['.codex-plugin/', '.claude-plugin/', '.zcode-plugin/', '.mcp.json', 'bin/', 'lib/', 'skills/', 'templates/', 'examples/', 'README.md']) {
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
