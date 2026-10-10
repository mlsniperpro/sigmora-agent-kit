---
name: sigmora
description: Drive Sigma, Sigmora's video co-editor, from Claude Code, Codex or Cursor. Use when the user wants to edit footage, cut a talk to a length, add captions or music, make a carousel, generate a clip or UGC ad, recreate a reference post, research ads and trends, or schedule idea runs in their Sigmora workspace. Needs SIGMORA_API_KEY.
license: MIT
---

# Sigmora (Sigma over the API)

Sigma is one agent. This skill talks to the same Sigma the Sigmora web app,
Slack, Discord, Telegram, Teams and WhatsApp talk to, through `/v1/sigma`, with
the user's own member API key. Edits, approvals and billing are identical to
the web app, and every turn shows up in the project's Sigma panel there.

## Setup

- `SIGMORA_API_KEY`: a member API key (`sk_live_...`) from **Settings > API keys**
  in the user's workspace. Never print it, commit it or put it in a URL.
- `SIGMORA_BASE_URL` (optional): defaults to `https://sigmora.org/api`.
- Run commands with `node <skill-dir>/scripts/sigmora.mjs <command>` (Node 18+,
  no install). Every command prints the JSON answer; a non-zero exit is an error
  whose `error.message` is written for a person.

Install: `npx skills add mlsniperpro/sigmora-platform --skill sigmora`, or copy
this folder (`plugins/sigmora/skills/sigmora`) into your agent's skills directory
(`~/.claude/skills/sigmora`, `.codex/skills/sigmora`, `.cursor/skills/sigmora`).

Prefer MCP? The same capabilities are MCP tools (`sigma_turn`, `sigma_approve`,
`sigma_apply`, `sigma_revert`, `jobs_get`, `projects_get`) on
`https://api.sigmora.org/mcp` with the same key: see
https://docs.sigmora.org/mcp-server.

## The loop

1. **Talk.** `sigmora turn "<what the user wants>" [--project ID] [--thread ID]`
   - No `--thread` starts a conversation; pass the returned `threadId` on every
     later turn so Sigma keeps the context.
   - No `--project` is fine: the first turn that makes something creates a
     project and returns its `projectId`. Pass `--project` to work in an
     existing one.
   - `--mode review` (default) returns each edit as a signed proposal;
     `--mode agentic` lands free, reversible edits at once and returns their
     `turnId`s.
   - Point at a frame (Mark-to-Fix): `--at 12.4 --region 0.1,0.2,0.3,0.3`
     (0..1 from the top-left, whole frame when omitted) and optionally
     `--still <image asset id>`.
2. **Show the reply** (`reply`) to the user. It cites sources as links when
   Sigma researched the web, the Meta Ad Library or the workspace's watched
   trends.
3. **Edits in review mode** come back in `proposals[]`. Show each `summary`;
   when the user agrees, `sigmora apply '<proposals[i].proposal as JSON>'`
   (or `@file` / `-` for stdin). Free.
4. **Paid work** comes back in `approvals[]`, each with its quote: `credits`,
   `modelLabel` (which model runs) and, when it cannot run, `unavailable`
   naming the missing key. Show the quote and **ask the user**. Only after an
   explicit yes: `sigmora approve '<approvals[i].approval>' --thread <threadId>`.
   Never approve on your own, never approve one whose `unavailable` is set, and
   never retry an approval with a new `--key` (reuse the same key to retry; it
   replays instead of charging twice). An approval marked `autoApproved`
   already ran under the workspace's threshold: report its result instead.
5. **Follow the work.** An approval answers `summary`, `credits`, `artifacts[]`
   (`kind`, `title`, `mediaUrls`, `status`) and sometimes `jobId`.
   Poll `sigmora job <jobId>` every 10 to 20 seconds until `status` is `done`,
   `failed`, `cancelled` or `qa_failed` (never publish from `qa_failed`). Clips,
   decks and images land in the project either way:
   `sigmora project <projectId>` lists them.
6. **Undo.** `sigmora revert <turnId> [...]` takes back agentic edits.

## Rules

- Spending is real and every paid step needs the user's yes, even when the
  price looks small. Say the price and the model before asking.
- A refusal is an answer: report its reason as written (a missing key, too few
  credits). Do not substitute another tool or model.
- Scheduled ideas ("send me 5 ideas every Monday") are asked for in plain words
  in a turn. Sigma proposes a schedule approval that is free to set up; each run
  is billed like one Sigma reply. The user pauses or deletes it on the
  project's Plan board or in Settings.
- Keep one `threadId` per task so the user sees one conversation in the app.
