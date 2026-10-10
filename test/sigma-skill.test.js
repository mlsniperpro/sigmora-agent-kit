// node --test plugins/sigmora/test/sigma-skill.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markFrom, parseArgs, requestFor, send } from '../rest-skill/sigmora/scripts/sigmora.mjs';

test('a turn continues a thread in a project and carries a mark', () => {
  const { positional, flags } = parseArgs(['tighten', 'the', 'intro', '--thread', 't1', '--project', 'p1', '--mode', 'agentic', '--asset', 'a1', '--at', '12.5', '--region', '0.1,0.2,0.3,0.4', '--key', 'k1']);
  assert.deepEqual(requestFor('turn', positional, flags), {
    method: 'POST',
    path: '/v1/sigma/turns',
    idempotencyKey: 'k1',
    body: {
      message: 'tighten the intro',
      threadId: 't1',
      projectId: 'p1',
      mode: 'agentic',
      assetIds: ['a1'],
      mark: { atSec: 12.5, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    },
  });
  assert.equal(markFrom({ asset: [] }), undefined);
  assert.throws(() => markFrom({ region: '1,2' }), /x,y,w,h/);
});

test('approve, apply, revert, job and project map to the /v1 contract', () => {
  const approve = requestFor('approve', ['ref.sig'], { asset: [], thread: 't1', key: 'k2' });
  assert.deepEqual(approve, { method: 'POST', path: '/v1/sigma/approvals', idempotencyKey: 'k2', body: { approval: 'ref.sig', threadId: 't1' } });
  assert.ok(requestFor('approve', ['ref.sig'], { asset: [] }).idempotencyKey, 'a fresh key when none is given');
  assert.deepEqual(requestFor('apply', ['@p.json'], { asset: [] }, () => '{"tool":"edit_composition"}').body, { proposal: { tool: 'edit_composition' } });
  assert.deepEqual(requestFor('revert', ['a', 'b'], { asset: [] }).body, { turnIds: ['a', 'b'] });
  assert.equal(requestFor('job', ['j/1'], { asset: [] }).path, '/v1/jobs/j%2F1');
  assert.equal(requestFor('project', ['p1'], { asset: [] }).path, '/v1/projects/p1');
  assert.throws(() => requestFor('nope', [], { asset: [] }), /Unknown command/);
});

test('send uses the bearer key and the Idempotency-Key header, and flags an error envelope', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: false, error: { code: 'insufficient_credits', message: 'Add credits.' } }), { status: 402 });
  };
  const result = await send({ method: 'POST', path: '/v1/sigma/approvals', idempotencyKey: 'k', body: { approval: 'x' } }, { apiKey: 'sk_live_x', baseUrl: 'https://sigmora.test/api/', fetchImpl });
  assert.equal(calls[0].url, 'https://sigmora.test/api/v1/sigma/approvals');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_live_x');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k');
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
});
