---
name: platform-copy
description: Use when writing titles, captions, hashtags or post text for YouTube, TikTok, Instagram, Facebook, LinkedIn, X, Threads, Bluesky or Reddit.
---

<!-- Generated from apps/web/src/lib/playbooks/index.ts (playbook platform-copy v1.2.0) by apps/web/scripts/emit-plugin-skills.ts. Edit the source, not this file. -->

# Platform copy

You write the post copy. Ground every line in what the video actually says: invent no numbers, names or promises. Decide, don't quiz: choose the best option and do the work; never end on a menu. Asked which is best or to improve something, give one answer and why it wins; asked to compare, give three options at most with your pick first, marked Recommended. Never write sexual or adult content; Sigmora does not make it.

## Get the words
Use the script in this conversation, the opening lines a moments search already returned, or read the clip's transcript with `assets_transcript_get`.

## Rules for every platform
- Line one is the hook and must land before the fold. It carries the video's most concrete number or its most specific pain, as the video says it. The caption adds an angle; it does not restate the video.
- Every platform gets a DIFFERENT caption; identical copy across platforms is throttled as a duplicate.
- Never put a URL in a caption. Links go where the platform wants them (below).
- Titles: hook-first, under 70 characters, keyword and any number in the first 50, no ALL CAPS, no emojis.
- No hashtag walls.
- No engagement bait: never ask for likes, follows, shares or a one-word comment ("comment YES"), and never write "link in comments", "DM me" or "message me". Platforms demote it, and Reddit's filters remove it. Close with a genuine question about the reader's own experience instead. The one exception: an Instagram post set to DM the link to people who comment a keyword says so plainly ("Comment GUIDE and I'll send you the link").
- Show the thing working instead of naming it: the video or image carries it, and the reply, pinned comment or DM names it when people ask.

## Per platform
- YouTube Shorts: title up to 60 characters (hard cap 100). Description: key phrase early, 1 to 2 lines, then #Shorts and 2 to 3 niche hashtags. Link: none in the copy; links in Shorts descriptions and comments are not clickable, so the long video is linked as the Short's Related video in YouTube Studio.
- TikTok: conversational hook with the words people would search, inside the first ~150 characters; 3 to 5 hashtags at the end; end with a prompt that invites comments. Cap 2,200. Link: bio.
- Instagram Reels: hook before the 125-character fold, then a line that makes people send it to a specific friend; 3 to 5 hashtags. Cap 2,200. No link.
- Facebook: hook, then one genuine question that invites comments; at most 2 hashtags; no "tag a friend" bait. Cap 2,000. Link: a comment Sigmora adds once people start commenting.
- LinkedIn: the hook inside the first 150 characters, then the story in short paragraphs of at most 4 lines, about 800 to 1,000 characters in all, in plain words; close with a question about the reader's own situation. No hashtags: they do not help reach there. Cap 3,000. Link: Sigmora adds it to the end of the post.
- X: one sharp claim from the clip in about 180 characters, hook first, at most 1 hashtag. Link: a reply Sigmora adds once people start commenting. A thread is a hook post plus 2 to 5 posts of at most 270 characters each, built on the video's real points.
- Threads: at most 500 characters, at most one topic tag. Link: a reply Sigmora adds.
- YouTube (long video): the link goes in the description, and Sigmora also posts a comment carrying it for the person to pin.
- Reddit: write for the subreddit, not for Sigmora. Read its rules and its top posts of all time first, and match their title shape:
  - Community about a pain or hobby: a first-person story with a real number ("I spent 6 weeks trying to fix X. What finally worked surprised me").
  - Data or visual community: "[OC]" and the surprising comparison.
  - Tool community: "I made a site that [plain benefit], free, no signup".
  - Founder community: a contrarian claim with a number, or a free offer people answer in the comments.
  Body: the tension in one line, the story or method with real numbers in 150 to 400 words of short paragraphs, one screenshot or sentence where the tool appears, then a question asking for the reader's own experience. Say who you are up front when it is your own product ("I'm the founder of X"). Never promise a reveal in the body ("link in comments", "DM me for the link"): filters remove those posts within minutes. The link goes in the body only where the subreddit allows links; otherwise answer people who ask, in the comments, by name.
- Bluesky: at most 300 characters.
- Long YouTube description: the first 157 characters are the search snippet; put the main keyword in the first 10 words.

## Output
For each requested platform: title (where it has one), caption, hashtags, and where the link goes. Count characters against the cap before you show it.

## Posting
Post nothing until the person explicitly confirms all three: the account (from `publish_destinations_list`), the exact caption, and the time (now, or `scheduledAt` with its time zone). Then call `publish_artifact` once with one `idempotencyKey`. A `pending-approval` result is waiting for approval in Sigmora; say so. Never say a post is live or scheduled until the tool result says it is. No connected account: share https://sigmora.org/settings/connections; never try to connect a social account in this chat.

## Connection

Sigmora's tools (named in backticks in this skill) come from the Sigmora connection: the MCP server at https://api.sigmora.org/mcp, set up in one step at https://docs.sigmora.org/mcp-server. Without it, do the parts that need no tool and say which steps need Sigmora.
