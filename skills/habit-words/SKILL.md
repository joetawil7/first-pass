---
name: habit-words
description: Learns the words a user habitually writes to their coding agent that make its answers worse ("be 100% sure", "don't assume", "full review", "are you sure?", "all fine, right?"), from what they actually typed in their recent Claude Code sessions. Shows what each one does, what went wrong after it, and what to say instead, then writes the habit words block that maps each word to the checks it should trigger, so the checks run without the words. Use when asked to learn, read, refresh or review the user's habit words or prompts, "which of my words make you worse", from setup-first-pass's profile step, or when the start-of-session check says the habit words are due.
allowed-tools: Read Glob Grep
---

# habit-words

"Be 100% sure" or "make it bug free" names no place to look, so it changes how sure the
answer sounds, not what gets checked. This skill finds the words this user writes, from
their own prompts, and maps each to the checks it should mean. The user never has to write
them again, and when they do, the words trigger the checks instead of a more certain tone.

The block this skill writes follows `${CLAUDE_SKILL_DIR}/../setup-first-pass/assets/words-block.md`:
read it first, and keep its markers and shape.

## 1. Read the sessions

*Plugin:* `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" words` reads the user's last 20
Claude Code sessions that hold a prompt they typed (`--sessions <n>` for another number), from
`~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). It writes only what they typed to a
temp file and prints the file's path, what it left out, the newest prompt's time, and how many
prompts hit each phrase family. Left out: tool output, pasted text, notifications, messages
from other sessions, skill and system text, commands, compaction summaries and turns a script
started (`claude -p`). Prompts queued while the agent was busy are kept: they are often the
corrections. The one thing kept that the user did not type is the end of the agent's reply
before each prompt tagged "possible pushback". Anything that looks like a key, token,
password, email or phone number is replaced: best effort, so never quote a line that still
looks like one. Each run writes one new file; note every path.

Without the plugin (another tool), ask the user to paste 30 to 50 recent prompts, and work
from those.

Say the coverage before the findings: sessions, dates, prompts, what was left out. Read the
whole file. Past about 800 prompts, read every prompt the families or the pushback marker
tag, plus a sample of 150 of the rest, and say so.

## 2. Find the words

- The families are candidates, not verdicts. Keep a phrase where it asks for certainty or
  completeness without naming a check ("be 100% sure", "cover all cases"); drop it where it
  names one ("make sure the tests pass", "check if this is still true").
- Find the user's own phrases the families miss, by reading: stacked demands ("dont assume,
  be 100% confident, cover all gaps" in one breath), yes-shaped questions, absolutes ("no
  hacking is possible"), frustration, open grants, and the ones that work well.
- Count every phrase you report: `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" words --count "<regex>"`
  (repeat `--count` for several; one read), with the same `--sessions` as step 1, so the
  counts cover the prompts you read. Every number shown comes from a count, never from
  reading. Prompts where the user talks about the words (like a request to run this
  skill) are counted too: say how many.
- The impact: a prompt tagged "possible pushback" shows the end of the reply before it. A
  habit word followed, in the same session, by the user correcting the result ("reread your
  numbers", "that's wrong", "is it really working?") is the evidence. Quote at most a few
  words of a prompt, never a whole one, and never names, contacts, amounts or anything
  secret.

## 3. Map each word to checks

For each word keep:

- what the user writes, in their spelling;
- how often (prompts, sessions), from a count;
- what it does to an agent, in one line (why the answer gets worse, not better);
- what happened after it, with the date, where the sessions show it;
- the check it now triggers: the working rule that answers it, by its name (Evidence, the
  pre-mortem, Done means proven, Say the coverage, No yes by default, Pushback gets checked,
  Bugs: reproduce first, Grants stay narrow, One step at a time), or, when no rule covers
  it, one new instruction in the same style;
- what to say instead: the words that name the check.

Also list the prompts that worked (they named the check, the source or the scope), so the
user keeps them.

## 4. Show the user

A table: **You wrote · How often · What it does · What happened · Say instead**, the prompts
that worked, then the block you will write. Ask before writing it.

## 5. Write the block

With a yes, write the block between its markers: the heading, one line saying the words mean
the checks and never a more certain tone, and one bullet per word:
`"<the user's words>" (<n> prompts): <the check it triggers>`. The start marker is

```
<!-- first-pass:words:start v<plugin version> through <newest prompt's time from step 1> from <n> sessions (written by the habit-words skill from the user's own prompts; re-run it to refresh) -->
```

The start-of-session check reads `through` to say when the words are due again: once 20
sessions the user typed in have changed since. If the user says "not now" to a refresh, set
`through` in the existing marker to the current time and change nothing else.

Where: never in a file teammates share, because these are one person's words. So:
- in a main folder, right after the profile block in the root `AGENTS.md`;
- in a single repo, or wherever the profile block sits in a file the repo commits, in
  `~/.claude/CLAUDE.md` instead;
- an existing words block is replaced where it is, if that file is not shared; otherwise
  it is moved to `~/.claude/CLAUDE.md`, and the report says so.

Never edit outside the markers.

## 6. Clean up

Delete every file step 1 wrote (each `words` run writes one): they hold the user's prompts.
`node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" words --delete "<file>"` for each; it
fails if the name matches no file, so a mistyped name never reads as deleted. A file an
unfinished run left is removed by the next run once it is 6 hours old. The report ends
with:

```
Read: <n> prompts from <n> sessions, <first date> to <last date>; left out <what>
Words: <n> mapped (<n> new instructions), block <written to file | not written, because>
Temp files: <n> written, <n> deleted
```
