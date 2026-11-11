---
name: caption-style
description: Use when the person wants on-screen captions or subtitles on a video, or asks how they should look.
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook caption-style v1.0.0) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Caption style

Pick the caption look and apply it. Decide, don't quiz: choose the best option and do the work; never end on a menu. Asked which is best or to improve something, give one answer and why it wins; asked to compare, give three options at most with your pick first, marked Recommended. Never write sexual or adult content; Sigmora does not make it.

## Choose the look
- `editorial` (default): large phrases on one quiet rail. Premium, phone-readable, no karaoke clutter. Up to 28 characters a line.
- `clean`: white on a soft dark box, the house look.
- `bold`: bigger type, fewer words a line (18 characters), solid backing. Reads on a phone at arm's length.
- `active-word`: highlights the word being spoken from exact transcript timing; later words softened. 22 characters a line.
- `subtle`: small type, barely-there box, for footage the captions should not dominate. 42 characters a line.
- Kinetic (Sigma edits only): `kinetic-pop` (each spoken word lands larger in the accent colour), `kinetic-reveal` (words appear only as spoken), `kinetic-highlight` (the spoken word sits on an accent block). 20 characters a line.
Default choice: talking-head short, `bold` or `active-word`; brand or founder piece, `editorial`; B-roll-led or cinematic, `subtle`; high-energy short that asked for motion, a kinetic look.

## Apply it
- New edit from raw footage: `video_edit` with `settings.captions: true` and `settings.captionPreset` (editorial, clean, bold, active-word or subtle).
- An existing project: `edit_add_captions` with the look as `captionPreset`, show the proposal, then `sigma_apply` on it.
- Captions in other languages: `text_localize` (priced per language-minute).

## Placement
On vertical video the engine keeps captions above the bottom ~28% so platform buttons never cover them. Do not ask to move them lower.

## When you write caption or on-screen text yourself
- At most 2 lines a card; a line at most 42 characters and 7 words (use the look's shorter limit on vertical).
- Each card 1 to 6 seconds on screen, at most 20 characters a second.
- Break after a sentence ends; after a comma or clause once the line has 4 words or 18 characters.
- Never end a line on a, the, of, to, in, for, with, and, or, but, is, was, will, your, its: move it to the next line.

## Paid steps: quote, agree, run
1. Call the paid tool once WITHOUT `maxCredits`, with a new `idempotencyKey`. The answer is a quote; nothing is charged.
2. The quote carries the credits and the workspace balance. Show the person both and wait for a clear yes.
3. Call it again with the same inputs, `maxCredits` equal to the quoted credits and the SAME `idempotencyKey`.
4. For a `jobId`, poll `jobs_get` until `done`, `failed`, `cancelled` or `qa_failed`; only `done` is success. Never resubmit because a response or a poll failed; a retry reuses the same key.

If the balance is short, say the cost and the balance in one plain sentence and link only https://sigmora.org/pricing, as information: "That render uses 300 credits. You have 100. Plan and credit details: https://sigmora.org/pricing". Do not pitch plans or promotions and never link any other payment page.
