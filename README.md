# first-pass

[![validate](https://github.com/joetawil7/first-pass/actions/workflows/validate.yml/badge.svg)](https://github.com/joetawil7/first-pass/actions/workflows/validate.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

first-pass makes a coding agent check the code around a change, not only the lines it
writes, and prove its work before it calls anything done. It's a Claude Code plugin;
Cursor, Codex and other agents get the same rules and skills (the hooks are Claude Code
only). You set it up once, in the folder that holds your repos.

**What it does**

- **Before code,** the agent answers ten questions about the change against the real code:
  what happens if it runs twice, stops halfway, or an outside service times out; which
  other code uses the same data; what the user sees when it fails. Each answer is a
  `file:line`, a test, or a gap you decide to accept.
- **Before "done",** a second agent that didn't write the code reviews it in a fresh
  context. "Done" needs a test that failed before the change and CI's checks passing in a
  clean checkout; anything less is reported as built, not done.
- **On a bug,** it fixes the whole class: it reproduces the bug, finds the same pattern
  elsewhere, and adds the check that stops it coming back.
- **On a pull request,** `/first-pass:review` checks your own branch before you ask for
  review, or a teammate's PRs across several repos. Every finding comes with its proof or
  is marked unproven, and it never posts to GitHub.
- **In every session,** hooks send back a "done" that has no evidence behind it, run each
  repo's own hooks from the shared folder, and say what drifted since setup.

**What it helps with**

- Bugs next to the change: the other code path that writes the same field, the webhook
  that arrives twice, the error that shows up as an empty list.
- "Fixed" and "verified" that only meant "it compiles and the mocks pass".
- An agent reviewing its own work in the same context that wrote it.
- Many repos opened from one folder, where each repo's own rules and hooks don't load.
- Prompts like "be 100% sure", which change how sure the answer sounds, not what gets
  checked.

```
/plugin marketplace add joetawil7/first-pass
/plugin install first-pass@first-pass
```

Then, in the folder where you start your sessions: `/first-pass:setup-first-pass`.

## Why I made this

I built a product feature by feature with Claude Code. Every feature request ended with
some version of "make sure the code is correct and bug free, cover all gaps, be 100% sure."
Then I ran a full audit. It found **318 issues, 25 of them high severity.**

When I sorted them, only 45 were mistakes in the lines being written. The rest were in the
code around those lines:

| What went wrong                                                   | Issues |
| ----------------------------------------------------------------- | -----: |
| Another code path using the same data was not updated             |     54 |
| Runs twice, runs at the same time, or stops halfway               |     54 |
| An outside service fails or is slow, and the error is hidden      |     45 |
| A plain mistake in the code itself                                |     45 |
| Time, units, rounding                                             |     26 |
| Scale: no limit, no index, lists that stop at one page            |     25 |
| Endings: cancel, delete, expire, reconnect, downgrade             |     19 |
| UI, help, legal or pricing text that says what the code doesn't do |    18 |
| Pipeline: CI red, no tests against a real database                |     17 |
| Hostile user or uncapped cost                                     |     15 |

(One private codebase, sorted by hand with one cause per issue. Your mix will differ.)

Several of these had been found by earlier audits and fixed. Each fix patched one spot,
and nothing carried the lesson into the next session.

"Be 100% sure" changed how sure the answers sounded. It never made the agent open the other
file that writes the same field, or ask what happens when the webhook arrives twice. So
first-pass names those checks, and asks for proof before anything is called done:

- **Ten questions before code** (the pre-mortem): twice, halfway, outside call, failure is
  not empty, neighbors, endings, money, hostile user, words, scale and time. Each answer is
  a `file:line`, a test, or "Not handled, because ___" for you to accept.
- **A reviewer that didn't write the code.** Models are poor at catching their own mistakes
  in the context that made them ([Huang et al., 2024](https://arxiv.org/abs/2310.01798)),
  so the `breaker` agent reviews each change in a fresh context, starting from the other
  code paths that touch the same data.
- **"Done" means a test that failed before the change**, the breaker's review, and CI's own
  checks passing in a clean checkout. Short of that, it's reported as built, not done.
- **Bugs get fixed as a class**: reproduce, find the same pattern elsewhere, and add the
  helper, constraint or check that stops it coming back.

## What's in it

| Piece | What it does | When |
| --- | --- | --- |
| `premortem` | The ten questions, answered against the code | Before code |
| `breaker` (agent) | Fresh-context review of the diff and of every other path touching the same data; concrete findings only | Before done |
| `ship-check` | The definition of done, ending in a report where every "Verified" line has its command and result | Before done |
| `fix-the-class` | Reproduce, name the class, search for it everywhere, run the ten questions on the fix, fix or record each hit, make it hard to repeat | On any bug |
| `setup-first-pass` | Writes the rules once, a map of your repos, and a section per repo with its real commands, test limits and a drafted `INVARIANTS.md` | Once, then to update |
| `habit-words` | Reads what you typed in your recent sessions and maps words like "be 100% sure" to the checks they should mean | At setup, then when due |
| `sharpen` | Rewrites the prompt you type after it: numbered asks, habit words turned into checks, names and numbers kept exactly. Shows you the rewrite, then works from it | Only when you type it |
| `review` | Reviews your own branch before you ask for review (type nothing after it), or a teammate's PRs, several repos at once. Checks the change against its ticket, judges the failed checks and every Bugbot comment, runs the breaker, traces the other code that uses what changed, proves each finding or marks it unproven, and says what the merge needs and how to check the deploy. Reads GitHub and never posts; pushes a fix only on your yes | Only when you type it |
| Hooks | Run each repo's own hooks from the main folder, send back a "done" with no evidence, say what drifted at session start, and hold `sharpen`'s work until its rewrite is shown | Every session |

## If you keep all your repos in one folder

A lot of us open one folder with every repo in it and start each session there. Claude Code
then finds agents, skills and hooks only in that folder and above it: a repo's own
`.claude/agents`, its `.claude/settings.json` hooks and its `.cursor/rules/*.mdc` imports
never load, and its CLAUDE.md loads only once a file in it is read. first-pass is built for
that:

- **One set of rules at the root**, in `AGENTS.md` (imported by `CLAUDE.md`), loaded from
  the first message and updated in one place.
- **A section per repo**, written from what setup finds in it: CI's exact commands, how to
  run one test, what the real tests need running, test limits, where its user-facing words
  live, and the same job done in two places. It loads when work reaches that repo.
- **Each repo's own hooks still run.** Setup lists them and you approve each one. An
  approval pins the hook and every file in its script's folder: if a pull changes one, the
  hook pauses until you approve it again, and you and the agent are both told.
- **Drift is reported at session start**: a repo's CI changed since its section was written,
  a new repo appeared, a hook was paused, a Cursor rule's copy fell behind, the rules are
  older than the plugin.
- **One repo on its own works too**: setup writes the rules and the section into that repo.

## Your habit words

Most of us have words we type out of habit: "be 100% sure", "don't assume", "full review",
"all fine, right?". They name no place to look, so the answer sounds more certain without
anything more being checked.

`habit-words` reads what you typed in your last 20 Claude Code sessions, shows how often you
use each phrase, what went wrong after it, and what to say instead. Then it writes a short
block that maps each phrase to the checks it should trigger. You never have to type them
again, and if you do, they mean the checks, not a more confident tone.

What it reads and keeps:

- Only your own transcripts in `~/.claude/projects`, and only what you typed, plus the end
  of the agent's reply before each prompt that pushes back on it. Tool output, pasted text,
  notifications and script-started runs are left out.
- Anything that looks like a key, token, password, email or phone number is replaced before
  the text goes into a temp file (best effort, so the skill also never quotes one). The
  skill deletes the file when it's done.
- The block holds only your phrases and the checks, and never goes into a file your
  teammates share.

## What it writes to your machine

- `AGENTS.md` and `CLAUDE.md` at the root, and a section in each repo's `CLAUDE.md` or
  `AGENTS.md`, all between `first-pass` markers. Outside the markers it adds only import
  lines, and it lists each one it adds.
- `INVARIANTS.md` in each repo (a draft for you to review), `.first-pass/workspace.json` at
  the root, and `.claude/cursor-rules/*.md` copies where a repo imports `.mdc` files.
- A small state folder in `~/.claude/plugins/data/` for the hooks, and a temp file while
  `habit-words` runs, deleted when it's done.

It never commits, pushes or sends anything anywhere. You review the files and commit them.

## Install

### Claude Code

```
/plugin marketplace add joetawil7/first-pass
/plugin install first-pass@first-pass
```

From a terminal: `claude plugin marketplace add joetawil7/first-pass`, then
`claude plugin install first-pass@first-pass`. To update later:
`claude plugin marketplace update first-pass`, then `claude plugin update first-pass@first-pass`.

The hooks need Node.js 18 or later on your PATH. The tests run on Windows and Linux.

### Cursor, Codex and other agents

```
npx skills add joetawil7/first-pass -a cursor --copy        # this project
npx skills add joetawil7/first-pass -a cursor --copy -g     # every project
```

This uses the [skills CLI](https://github.com/vercel-labs/skills). Swap `-a cursor` for your
agent (`-a codex`, `-a windsurf`, ...). `--copy` writes real files instead of symlinks,
which Windows checkouts turn into plain text. Don't add `-a claude-code` if you use the
plugin, or you'll get every skill twice. Other tools get the rules and skills; the hooks are
Claude Code's.

### Then run setup once

In the folder where your sessions start: `/first-pass:setup-first-pass` (or
`/setup-first-pass` outside Claude Code). It looks through your repos, asks only what the
code can't tell it (which repos have a UI, which depend on which, which repo hooks to run),
and writes the files above. Re-run it after an update: your own text, each repo's section and
`INVARIANTS.md` are kept.

### Teammates

Once a repo's files are committed, every teammate's agent loads its section. Tell setup
which repos people open on their own: those also get the rules and a copy of the breaker.
Each person installs the skills: the plugin for Claude Code, the `npx skills` line for
Cursor.

## Day to day

1. **Plan.** Ask for the change. The agent runs the pre-mortem before it edits. Read the
   "Not handled, because" lines: those are your calls.
2. **Build**, with the tests the pre-mortem named, each one failing on the old code first.
3. **Done.** `ship-check` runs the breaker and CI's checks in a clean checkout, then reports
   `Verified: <command> → <result>` and what wasn't verified.
4. **Bug.** `fix-the-class` fixes the one you found, the others like it, and adds the check
   that stops the next one.
5. **Review.** On your own branch, `/first-pass:review` with nothing after it reviews your
   work against its base, its PR, its checks and the ticket in the branch name, and ends
   with what to fix before you ask for review. On a teammate's PR, add the links and what's
   live, for example *"/first-pass:review backend#147 web#151, live today: no agency
   workspaces"*: the same checks, plus a message you can send the developer. Every finding
   comes with its proof, or is marked unproven, and says whether users can hit it today. A
   PR from a fork or an outside contributor is read, never run, unless you say yes, since
   running it would run a stranger's code with your logins. The report also says what
   changes for users, what the merge needs (a new app build, env vars, migrations, deploy
   order), what to check after the deploy, and which of the ten questions and which
   neighboring code were checked. It reads GitHub but never posts, and it fixes something
   only when you pick it after the report.

Instead of "make sure it's bug free", try: *"Run the pre-mortem, show me the tests that fail
without the change, and list what you didn't verify."*

Or write the prompt the way you would anyway and put `/first-pass:sharpen` in front of it
(`/sharpen` in Cursor). It splits a message that mixes three asks into a numbered list,
turns the habit words into the checks they stand for, shows you the rewrite, and works from
that. It stops to ask only when it would have to guess, and it never adds work you didn't
ask for. In Claude Code a hook holds back edits, shell commands, subagents, MCP tools,
publishing, scheduling and other skills until the rewrite is on screen (reading files is
never held back): with the
instruction alone, the rewrite was skipped in 7 of my 11 test runs.

## What it won't do

- **It's slower per change.** A test that fails first, a second agent's review and CI in a
  clean checkout take time and tokens. On a small demo repo, fixing one double-charge bug
  with `fix-the-class` and then running `ship-check` used about $29 at API list prices
  (three reviewer passes). The trade is fewer rounds after "done". The pre-mortem scales
  with the change: a copy tweak answers it in one line.
- **It won't make code bug free.** The aim is fewer and smaller escapes: no high-severity
  ones, no bug class found twice. This is version 0.3, so that's the design, not a measured
  result yet.
- **Rules alone fade.** The fixes that last are the ones `fix-the-class` pushes toward: a
  shared helper that's the only way to do a thing, a database constraint, a CI check.
- **The hooks only see edits made with Claude Code's edit tools.** A file changed by a shell
  command isn't noticed by the done check or the end-of-turn hooks.

## Related

- [superpowers](https://github.com/obra/superpowers): a full development method for coding
  agents, as skills.
- [anthropics/skills](https://github.com/anthropics/skills): Anthropic's examples of skills.
- Huang et al., [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) (ICLR 2024)
- Tambon et al., [Bugs in Large Language Models Generated Code](https://arxiv.org/abs/2403.08937)
- Anthropic, [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)

## Feedback

If you try it and it gets in your way, [open an issue](https://github.com/joetawil7/first-pass/issues)
and tell me where. Reports of a bug that got past all of this are the most useful kind.

## License

[MIT](LICENSE)
