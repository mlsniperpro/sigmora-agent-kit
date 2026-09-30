---
name: short-form-script
description: Use when the person wants a script for a TikTok, Reel or YouTube Short (15 to 60 seconds), or a hook for one.
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook short-form-script v1.0.0) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Short-form script

You write the script; Sigmora supplies evidence and later edits the footage. Decide, don't quiz: choose the best option and do the work; never end on a menu. Only when asked to compare, give 2 to 6 options. Never write sexual or adult content; Sigmora does not make it.

## Before writing
- Know the topic, the platform and who it is for. If one is missing and it changes the script, ask one short question.
- Optional evidence: `hooks_search` (niche, platform, hookType) returns observed hooks with sources. Cite only what it returns; never invent performance numbers.

## Length
Target 15 to 60 seconds. Budget about 145 spoken words per minute: 15 s is about 35 words, 30 s about 70, 60 s about 140. Too long? Cut words, never ask them to talk faster. Short-form wins on completion, so right-size it; never pad.

## Hook (first line, first 2 seconds)
State the idea and show it happening in the first two seconds. No greeting, no intro. Pick ONE pattern:
- Self-diagnosis: the viewer recognizes their problem.
- Insider secret: knowledge they do not have.
- Hot take: a position they want to argue with.
- Suspense: tension that resolves only if they stay.
- POV: drop them inside one moment.
- Listicle: a finite number to count off (odd numbers read curated).
- Bold claim: an absolute they feel they must check.
- Question: an open loop they need closed.
- Stat shock: a number that contradicts intuition.
- Story open: start mid-anecdote.
Grammar under all of them: concrete specifics (exact amounts, days, counts, never vague adjectives), a contrast or twist inside the first two sentences, present tense. Keep the curiosity gap moderate and pay it off inside the video: clickable but true.

## Body
One idea, one constraint that creates the tension. Move through confidence, pressure, payoff; every beat changes the situation. Short, concrete words, no jargon. Use one number: precise and odd for proof ("37 rejections"), round and big for scale. Write numbers the way they are spoken.

## Ending
End the moment the payoff lands. At most one line of call to action or one question that invites comments. No recap, no outro.

## Output format
1. Hook line, with the on-screen action for 0 to 2 s.
2. Beats: each spoken line plus what is on screen (every spoken idea gets a visual; the frame is never static).
3. Payoff and the closing line.
4. Word count and estimated seconds at 145 words per minute.
Never invent statistics, names or results; mark any claim that needs a source.

## Next
When they have recorded it, bring the footage in with `assets_import` (a file or public URL) and follow the review-first-edit playbook.
