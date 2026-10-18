---
name: repurpose-long-video
description: Use when the person has a long video, podcast or stream and wants short vertical clips from it.
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook repurpose-long-video v1.0.0) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Repurpose a long video

Turn one long video into standalone vertical shorts. Decide, don't quiz: choose the best option and do the work; never end on a menu. Only when asked to compare, give 2 to 6 options. Never write sexual or adult content; Sigmora does not make it.

## Start in one project
Find the project with `projects_list` or make one with `projects_create`, and pass that `projectId` to every later call in this conversation. If two projects plausibly match, ask one short question before any paid step.

## 1. Bring the video in
`assets_import` with the file or a public URL (YouTube works). A very large file: `assets_upload_prepare` returns an upload link bound to the project. Wait until the asset is ready.

## 2. Find the moments
`video_moments` with `assetId`, `platforms` and `maxClips` (paid per transcript-minute). It scores each stretch for standing alone, hook and payoff, and returns cue-safe ranges with the exact opening line.
- By source length: up to 8 min, about 5 clips of 25 s; up to 30 min, 8 of 40 s; longer, 8 of 55 s.
- Platform windows: YouTube Shorts 13 s-3 min, TikTok 15-60 s, Instagram Reels 15 s-15 min, Facebook Reels 3-90 s, Snapchat Spotlight 6-60 s. The strictest requested platform wins (say so when one platform shortens a clip, e.g. TikTok's 60 s or Facebook's 90 s). Never pad a short clip.

## 3. Choose, and show your picks
A good short is one idea that opens on a hook and resolves inside the clip; never a teaser that needs the full video. Prefer the cold open, the central reveal, the counter-intuitive number and the human payoff. For each pick show start-end, length, the opening line verbatim and one line on why. Flag a `selectedBy: fallback` result or any warning as "needs your eye".

## 4. Cut
- Footage imported here: `video_edit` with `clipIds`, `makeLong: false`, `shortsCount`, `shortsPlatform`, `reviewCuts: true` and captions on. Poll `jobs_get` to `awaiting_review`, read the plan with `jobs_proposal_get`, then `video_edit_approve` with `appliedCutIds` and `shortMomentIds` in publish order.
- A finished Sigmora render: `video_shorts` with its `jobId`, `platforms` and `maxPerPlatform`.

## 5. Package and roll out
- Each short gets its own title and caption (platform-copy playbook). A weak first line gets a sharper opening that reframes that same line, with no new claims.
- Order: broadest hook, then curiosity, then contrarian or niche, 2 days apart. Point each back to the long video where that platform puts links.
- Localize only a short that earned it (about 20K views in 30 days at 50%+ retention).

## Paid steps: quote, agree, run
1. Call the paid tool once WITHOUT `maxCredits`, with a new `idempotencyKey`. The answer is a quote; nothing is charged.
2. The quote carries the credits and the workspace balance. Show the person both and wait for a clear yes.
3. Call it again with the same inputs, `maxCredits` equal to the quoted credits and the SAME `idempotencyKey`.
4. For a `jobId`, poll `jobs_get` until `done`, `failed`, `cancelled` or `qa_failed`; only `done` is success. Never resubmit because a response or a poll failed; a retry reuses the same key.

If the balance is short, say the cost and the balance in one plain sentence and link only https://sigmora.org/pricing, as information: "That render uses 300 credits. You have 100. Plan and credit details: https://sigmora.org/pricing". Do not pitch plans or promotions and never link any other payment page.

## Posting
Post nothing until the person explicitly confirms all three: the account (from `publish_destinations_list`), the exact caption, and the time (now, or `scheduledAt` with its time zone). Then call `publish_artifact` once with one `idempotencyKey`. A `pending-approval` result is waiting for approval in Sigmora; say so. Never say a post is live or scheduled until the tool result says it is. No connected account: share https://sigmora.org/settings/connections; never try to connect a social account in this chat.
