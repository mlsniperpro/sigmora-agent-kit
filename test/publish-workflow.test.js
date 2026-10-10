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
  // setup-node's registry-url would shadow the trusted-publisher exchange.
  assert.doesNotMatch(workflow, /^\s+registry-url:/m);
  assert.match(workflow, /if \[ -n "\$NPM_TOKEN" \]; then/);
  for (const uses of workflow.match(/uses: \S+/g) ?? []) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} must pin a commit`);
});

// Splits a workflow into its jobs and each job into its steps, by indentation
// (the kit has zero dependencies, so no YAML parser).
function workflowJobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const jobs = {};
  for (const block of body.split(/^(?= {2}[A-Za-z][\w-]*:\n)/m)) {
    const name = block.match(/^ {2}([A-Za-z][\w-]*):\n/)?.[1];
    if (!name) continue;
    const stepsAt = block.indexOf('\n    steps:\n');
    jobs[name] = {
      head: stepsAt === -1 ? block : block.slice(0, stepsAt),
      steps: stepsAt === -1 ? [] : block.slice(stepsAt).split(/^ {6}- /m).slice(1),
    };
  }
  return jobs;
}

test('publish credentials never meet an install or the kit test run (W5R1-MONEY-AUTH-01)', async () => {
  const workflow = await readFile(join(KIT_ROOT, '.github/workflows/publish.yml'), 'utf8');
  const jobs = workflowJobs(workflow);
  // The kit has zero dependencies: nothing is ever installed in the release.
  assert.doesNotMatch(workflow, /npm (install|ci|i)\b|pnpm|yarn/);
  assert.deepEqual(
    Object.entries(jobs).filter(([, job]) => /id-token: write/.test(job.head)).map(([name]) => name),
    ['publish'],
  );
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'publish') continue;
    assert.doesNotMatch(job.head + job.steps.join(''), /id-token|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./, name);
  }
  const publish = jobs.publish.steps;
  assert.doesNotMatch(publish.join(''), /npm run|npm test|actions\/checkout/);
  const test = jobs.test.steps.join('');
  assert.ok(test.indexOf('run: npm test') !== -1 && test.indexOf('run: npm test') < test.indexOf('npm pack --ignore-scripts'));
  assert.match(jobs.publish.head, /needs: test/);
  assert.deepEqual(publish.filter((step) => /NPM_TOKEN/.test(step)), [publish.at(-1)]);
  assert.match(publish.at(-1), /npm publish "\$tarball" --provenance --access public --ignore-scripts/);
});

test('the monorepo mirrors plugins/sigmora from main only, with a main-only environment key', monorepoOnly, async () => {
  const workflow = await readFile(join(REPOSITORY_ROOT, '.github/workflows/mirror-agent-kit.yml'), 'utf8');
  assert.match(workflow, /paths:\n\s+- "plugins\/sigmora\/\*\*"/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /secrets|contents: write|id-token: write/);
  // W5R1-MONEY-AUTH-02: one reusable mirror job; only main reaches the key in
  // the `agent-kit-mirror` environment (deployment branches: main).
  assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'\n {4}uses: \.\/\.github\/workflows\/mirror-subtree\.yml\n/m);
  assert.match(workflow, /^ {6}prefix: plugins\/sigmora\n/m);
  assert.match(workflow, /^ {6}remote: git@github\.com:mlsniperpro\/sigmora-agent-kit\.git\n/m);
  assert.match(workflow, /^ {6}environment: agent-kit-mirror\n/m);
  assert.match(workflow, /^ {6}deploy_key_secret: AGENT_KIT_MIRROR_DEPLOY_KEY\n/m);
  const subtree = await readFile(join(REPOSITORY_ROOT, '.github/workflows/mirror-subtree.yml'), 'utf8');
  assert.match(subtree, /^ {4}if: github\.ref == 'refs\/heads\/main'\n/m);
  assert.match(subtree, /^ {4}environment: \$\{\{ inputs\.environment \}\}\n/m);
  assert.match(subtree, /git push "\$MIRROR_REMOTE" mirror-split:refs\/heads\/main\n/);
  assert.doesNotMatch(subtree, /--force|\+mirror-split/);
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
