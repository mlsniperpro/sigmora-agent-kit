---
name: weekly-content-plan
description: Use when the person wants a content calendar, a week of post ideas, or a posting schedule.
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook weekly-content-plan v1.0.0) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Weekly content plan

Build a 7-day posting plan the person can run, then fill and schedule it with Sigmora. Decide, don't quiz: choose the best option and do the work; never end on a menu. Asked which is best or to improve something, give one answer and why it wins; asked to compare, give three options at most with your pick first, marked Recommended. Never write sexual or adult content; Sigmora does not make it.

## Start in one project
Find the project with `projects_list` or make one with `projects_create`, and pass that `projectId` to every later call in this conversation. If two projects plausibly match, ask one short question before any paid step.

## 1. Inputs
Niche, platforms, how many posts a week, and time zone. Ask one short question only for what is missing and changes the plan.

## 2. Evidence (free)
- `hooks_search` (niche, platform) for hooks observed working now, with sources.
- `creator_outliers` (creatorId, platform) for posts that beat a creator's own earlier ones: theirs, or a creator they name.
Cite only what these return. No evidence for an idea: say it is a bet.

## 3. Ideas
5 by default, at most 10, none already covered in this conversation. Each has a hook line, a format, why it should work now, and its source link. Drop any idea without an arc that holds to the end, however clickable.

## 4. Mix and order
- About 30% cornerstone (evergreen, builds search and trust) and 70% traffic-drivers (timely, recruits new viewers). A time-sensitive idea goes first; it loses value within days.
- Shorts cut from one long video: broadest hook first, then curiosity, then contrarian or niche, 2 days apart.

## 5. Slots
The first 24 to 48 hours set who a post reaches, so publish in the target audience's peak hours in their time zone. LinkedIn: business hours, Tuesday to Thursday, 8 to 10am.

## 6. The plan
A table: day | local time | platform | format | cornerstone or traffic | hook line | source (existing asset or "to film").

## 7. Fill it
- "To film": short-form-script playbook.
- An existing long video: repurpose-long-video playbook (`video_moments`, then cuts).
- Copy for each post: platform-copy playbook.

## 8. Schedule
One `publish_artifact` per post with `scheduledAt`. The person may confirm the whole week in one message, but it must list every post's account, caption and time.

## Paid steps: quote, agree, run
1. Call the paid tool once WITHOUT `maxCredits`, with a new `idempotencyKey`. The answer is a quote; nothing is charged.
2. The quote carries the credits and the workspace balance. Show the person both and wait for a clear yes.
3. Call it again with the same inputs, `maxCredits` equal to the quoted credits and the SAME `idempotencyKey`.
4. For a `jobId`, poll `jobs_get` until `done`, `failed`, `cancelled` or `qa_failed`; only `done` is success. Never resubmit because a response or a poll failed; a retry reuses the same key.

If the balance is short, say the cost and the balance in one plain sentence and link only https://sigmora.org/pricing, as information: "That render uses 300 credits. You have 100. Plan and credit details: https://sigmora.org/pricing". Do not pitch plans or promotions and never link any other payment page.

## Posting
Post nothing until the person explicitly confirms all three: the account (from `publish_destinations_list`), the exact caption, and the time (now, or `scheduledAt` with its time zone). Then call `publish_artifact` once with one `idempotencyKey`. A `pending-approval` result is waiting for approval in Sigmora; say so. Never say a post is live or scheduled until the tool result says it is. No connected account: share https://sigmora.org/settings/connections; never try to connect a social account in this chat.
