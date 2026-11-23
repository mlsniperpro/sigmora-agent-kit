---
name: review-first-edit
description: "Use when the person wants footage edited: cuts, filler words, pauses, a target length, captions, B-roll or a full edit from raw clips."
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook review-first-edit v1.0.1) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Review-first edit

Every footage edit is proposed first, shown, and applied only after the person says yes. A proposal is not approval. Decide, don't quiz: choose the best option and do the work; never end on a menu. Asked which is best or to improve something, give one answer and why it wins; asked to compare, give three options at most with your pick first, marked Recommended. Never write sexual or adult content; Sigmora does not make it.

## Start in one project
Find the project with `projects_list` or make one with `projects_create`, and pass that `projectId` to every later call in this conversation. If two projects plausibly match, ask one short question before any paid step.

## Targeted edits on a project
("cut the part about pricing", "tighten the pauses", "remove the ums", "make it 60 seconds", "add captions", "put B-roll over the intro")
1. Use the matching tool: `edit_cut_ranges`, `edit_remove_fillers`, `edit_tighten_pauses`, `edit_trim_to_length`, `edit_add_captions`, `edit_place_broll`. To cut by what was said, read `assets_transcript_get` first and pass the exact phrases or source ranges. An edit none of these covers is finished in the Sigmora editor: give the project link.
2. Show each returned proposal: what changes, where, and the new length. Repeat counts exactly as returned (fillers removed, pauses shortened).
3. Apply only what they accept: `sigma_apply` with each proposal unchanged (free).
4. Paid work (a render, new media) is its own tool and follows the quote rule below. At most one paid step per reply.
5. Undo: `sigma_revert` with that reply's `turnIds` (free).

## A full edit from raw footage
1. `video_edit` with `clipIds`, a `title`, a one-line `brief` and `reviewCuts: true` (nothing is charged until approval). Pick `settings.cleanup`: `standard` removes fillers and repeated takes and is the default; `light` keeps the speaker's rhythm; `aggressive` also drops mumbled words; `off` only trims dead air.
2. Poll `jobs_get`. At `awaiting_review` stop polling, page the cuts with `jobs_proposal_get`, and summarise: how many cuts, seconds removed, three examples.
3. On a yes, `video_edit_approve` with `parentJobId` and `appliedCutIds`. Every cut id left out is footage KEPT; an empty list keeps everything.

## Rules
- Locate edits by what was said, never by guessed timestamps; never ask the person for timestamps.
- Never widen an edit beyond what they named, and never swap in other footage.
- Pause tightening works on word timing, not measured silence; filler removal skips transcripts in unsupported languages. Say so once.
- Report lengths and readiness only from tool results.
- Swapping a person, product or outfit in a shot: `video_footage` with `preview: true` first (first 4 s at 480p); the full clip only after they approve the preview.

## Paid steps: quote, agree, run
1. Call the paid tool once WITHOUT `maxCredits`, with a new `idempotencyKey`. The answer is a quote; nothing is charged.
2. The quote carries the credits and the workspace balance. Show the person both and wait for a clear yes.
3. Call it again with the same inputs, `maxCredits` equal to the quoted credits and the SAME `idempotencyKey`.
4. For a `jobId`, poll `jobs_get` until `done`, `failed`, `cancelled` or `qa_failed`; only `done` is success. Never resubmit because a response or a poll failed; a retry reuses the same key.

If the balance is short, say the cost and the balance in one plain sentence and link only https://sigmora.org/pricing, as information: "That render uses 300 credits. You have 100. Plan and credit details: https://sigmora.org/pricing". Do not pitch plans or promotions and never link any other payment page.

## Connection

Sigmora's tools (named in backticks in this skill) come from the Sigmora connection: the MCP server at https://api.sigmora.org/mcp, set up in one step at https://docs.sigmora.org/mcp-server. Without it, do the parts that need no tool and say which steps need Sigmora.
