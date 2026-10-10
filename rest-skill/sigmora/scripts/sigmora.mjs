#!/usr/bin/env node
/**
 * sigmora: a zero-dependency CLI over Sigmora's /v1 Sigma API, for agents
 * (Claude Code, Codex, Cursor) using the Sigmora skill. Node 18+ (global fetch).
 *
 *   SIGMORA_API_KEY   required: a member API key (Settings > API keys, sk_live_...)
 *   SIGMORA_BASE_URL  optional: default https://sigmora.org/api
 *
 * Every command prints the JSON response and exits non-zero on an error
 * envelope, so an agent can read the result and branch on it.
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const USAGE = `sigmora <command> [options]

  turn "<message>" [--thread ID] [--project ID] [--mode review|agentic]
                   [--asset ID ...] [--at SEC] [--region x,y,w,h] [--still ASSET_ID]
      One turn with Sigma. Prints reply, proposals, approvals (with quotes) and links.
  approve <approval-ref> [--thread ID]
      Run one paid approval from a turn's approvals[].approval. Only after the user agreed.
  apply <proposal-json|@file|-> [--thread ID]
      Apply one review-mode edit from a turn's proposals[].proposal (free).
  revert <turnId> [<turnId> ...]
      Take back agentic edits by their turnIds (free).
  job <jobId>
      Poll an async job until you see done, failed, cancelled or qa_failed.
  project <projectId>
      Read a project and everything filed in it (artifacts, renders, decks).

Options: --key <idempotency-key> (default: a new UUID per call; reuse it to retry safely).`;

export function parseArgs(argv) {
  const positional = [];
  const flags = { asset: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
    index += 1;
    if (name === 'asset') flags.asset.push(value);
    else flags[name] = value;
  }
  return { positional, flags };
}

/** The mark (Mark-to-Fix): one frame, an optional 0..1 box, an optional still. */
export function markFrom(flags) {
  if (flags.at === undefined && flags.region === undefined && flags.still === undefined) return undefined;
  const mark = {};
  if (flags.at !== undefined) mark.atSec = Number(flags.at);
  if (flags.region !== undefined) {
    const [x, y, w, h] = String(flags.region).split(',').map(Number);
    if ([x, y, w, h].some((value) => !Number.isFinite(value))) throw new Error('--region is x,y,w,h between 0 and 1.');
    mark.region = { x, y, w, h };
  }
  if (flags.still !== undefined) mark.stillAssetId = flags.still;
  return mark;
}

/** The HTTP request a command makes. Pure, so the contract is testable without a network. */
export function requestFor(command, positional, flags, readInput = () => '') {
  const key = flags.key ?? randomUUID();
  switch (command) {
    case 'turn': {
      const message = positional.join(' ').trim();
      if (!message) throw new Error('turn needs a message.');
      const mark = markFrom(flags);
      return {
        method: 'POST',
        path: '/v1/sigma/turns',
        idempotencyKey: key,
        body: {
          message,
          ...(flags.thread ? { threadId: flags.thread } : {}),
          ...(flags.project ? { projectId: flags.project } : {}),
          ...(flags.mode ? { mode: flags.mode } : {}),
          ...(flags.asset.length ? { assetIds: flags.asset } : {}),
          ...(mark ? { mark } : {}),
        },
      };
    }
    case 'approve': {
      if (!positional[0]) throw new Error('approve needs the approval reference from approvals[].approval.');
      return {
        method: 'POST',
        path: '/v1/sigma/approvals',
        idempotencyKey: key,
        body: { approval: positional[0], ...(flags.thread ? { threadId: flags.thread } : {}) },
      };
    }
    case 'apply': {
      const raw = positional[0] === '-' || positional[0]?.startsWith('@') ? readInput(positional[0]) : positional[0];
      if (!raw) throw new Error('apply needs the proposal JSON (inline, @file or - for stdin).');
      return {
        method: 'POST',
        path: '/v1/sigma/proposals/apply',
        body: { proposal: JSON.parse(raw), ...(flags.thread ? { threadId: flags.thread } : {}) },
      };
    }
    case 'revert':
      if (positional.length === 0) throw new Error('revert needs at least one turnId.');
      return { method: 'POST', path: '/v1/sigma/revert', body: { turnIds: positional } };
    case 'job':
      if (!positional[0]) throw new Error('job needs a jobId.');
      return { method: 'GET', path: `/v1/jobs/${encodeURIComponent(positional[0])}` };
    case 'project':
      if (!positional[0]) throw new Error('project needs a projectId.');
      return { method: 'GET', path: `/v1/projects/${encodeURIComponent(positional[0])}` };
    default:
      throw new Error(`Unknown command "${command ?? ''}".\n\n${USAGE}`);
  }
}

export async function send(request, { apiKey, baseUrl, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(request.body ? { 'Content-Type': 'application/json' } : {}),
      ...(request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, error: { code: 'invalid_response', message: text.slice(0, 500) } };
  }
  return { ok: response.ok && json.success !== false, status: response.status, json };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const apiKey = process.env.SIGMORA_API_KEY?.trim();
  if (!apiKey) {
    console.error('Set SIGMORA_API_KEY to a Sigmora member API key (Settings > API keys).');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const { positional, flags } = parseArgs(rest);
  const request = requestFor(command, positional, flags, (source) =>
    readFileSync(source === '-' ? 0 : source.slice(1), 'utf8'));
  const result = await send(request, { apiKey, baseUrl: process.env.SIGMORA_BASE_URL?.trim() || 'https://sigmora.org/api' });
  console.log(JSON.stringify(result.json, null, 2));
  if (!result.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
