import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { KIT_ROOT } from '../lib/config.js';

const REPOSITORY_ROOT = resolve(KIT_ROOT, '../..');
const inMonorepo = existsSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'));
const monorepoOnly = { skip: !inMonorepo && 'public mirror: the monorepo workflows are not part of it' };

test('the mirror publishes on an agent-kit tag with npm provenance (decision 8)', async () => {
  const workflow = await readFile(join(KIT_ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /tags:\n\s+- "agent-kit-v\*\.\*\.\*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /expectedTag = `agent-kit-v\$\{packageJson\.version\}`/);
  assert.match(workflow, /manifest\.version !== packageJson\.version/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /npm publish --provenance --access public/);
  // setup-node's registry-url would shadow the trusted-publisher exchange.
  assert.doesNotMatch(workflow, /^\s+registry-url:/m);
  assert.match(workflow, /if \[ -n "\$NPM_TOKEN" \]; then/);
  for (const uses of workflow.match(/uses: \S+/g) ?? []) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} must pin a commit`);
});

test('the monorepo mirrors plugins/sigmora with a deploy key and skips without it', monorepoOnly, async () => {
  const workflow = await readFile(join(REPOSITORY_ROOT, '.github/workflows/mirror-agent-kit.yml'), 'utf8');
  assert.match(workflow, /paths:\n\s+- "plugins\/sigmora\/\*\*"/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /git subtree split --prefix plugins\/sigmora --branch agent-kit-mirror/);
  assert.match(workflow, /secrets\.AGENT_KIT_MIRROR_DEPLOY_KEY/);
  assert.match(workflow, /::notice::AGENT_KIT_MIRROR_DEPLOY_KEY is not set/);
  assert.match(workflow, /MIRROR_REMOTE: git@github\.com:mlsniperpro\/sigmora-agent-kit\.git/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /git push "\$MIRROR_REMOTE" agent-kit-mirror:refs\/heads\/main\n/);
  assert.doesNotMatch(workflow, /--force|\+agent-kit-mirror/);
  const pkg = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.repository.url, 'git+https://github.com/mlsniperpro/sigmora-agent-kit.git');
});

test('no monorepo workflow publishes the agent kit or holds an npm token for it', monorepoOnly, async () => {
  const directory = join(REPOSITORY_ROOT, '.github/workflows');
  for (const name of await readdir(directory)) {
    const workflow = await readFile(join(directory, name), 'utf8');
    if (!/agent-kit|plugins\/sigmora/.test(workflow)) continue;
    assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN/, name);
  }
});
