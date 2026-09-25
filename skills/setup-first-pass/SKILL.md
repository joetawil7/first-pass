---
name: setup-first-pass
description: Set up first-pass for a main folder that holds many repos, or for one repo. In a main folder it writes one set of working rules at the root that every session loads, a workspace map, and a section in each repo with that repo's real commands, test limits and invariants, and it lists each repo's own hooks so first-pass can run them from the main folder. In one repo it writes the rules and the section into that repo. Use when asked to set up, install, add, update or re-run first-pass, to "add the shipping rules", or when the start-of-session check says something drifted. Re-run to update.
allowed-tools: Read Glob Grep
---

# setup-first-pass

Installs first-pass so every session, in every tool the team uses, starts with the rules,
and each repo's own facts load when work reaches that repo.

The files this skill copies are in its own folder, `${CLAUDE_SKILL_DIR}/assets/`:
`rules-block.md`, `profile-block.md`, `words-block.md`, `workspace-block.md`,
`project-block.md`, `INVARIANTS.md` and `breaker.md`. (Claude Code fills in that path. In other tools it is the
folder this SKILL.md was loaded from.) Read them from there and copy them exactly; never
write them from memory. If they cannot be read, stop and say so.

With the Claude Code plugin, `${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs` exists: it does
the deterministic parts (`survey`, `record`, `cursor-rules`, `check`). Without it (a skills
install in another tool), do the survey by reading, and skip the steps marked *plugin*.

Nothing is committed, pushed or branched: the owner reviews and commits.

## 0. Which mode

- **Main folder**: the current folder holds two or more git repos (the survey looks two
  levels down and follows links), whether or not it is a git repo itself, or it has
  `.first-pass/workspace.json`. Sessions start here, and a repo's own agents and hooks
  never load (Claude Code finds them only in the folder a session starts in and above it),
  while its CLAUDE.md loads once a file in it is read.
- **One repo**: the current folder is a git repo holding no other repos. Follow the steps
  with "the workspace" and "each repo" both meaning this repo; skip the workspace block and
  steps 4 and 6.
- **Neither** (not a repo, and fewer than two repos inside): ask the owner which folder
  their sessions start in, and run setup there.

## 1. Survey (read only)

*Plugin:* `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" survey .` prints, as JSON, every
repo (including folders a `.code-workspace` file adds from outside), with: stack and
frameworks, a UI guess and why, package scripts, CI files and the commands each job runs,
test configs, test folders and compose files, monitoring packages, where words live,
instruction files and their imports, instruction files Claude Code will not load
(`loadProblems`, `cursorRuleProblems`), the repo's own Claude Code hooks (identical copies
share a `contentKey`), its agents and skills, and problems (unreadable files). Save it to a temp file and read it; for more than 20 repos,
summarise it with a script.

Then, for each repo, read what the survey only points at: the CI file itself (which jobs
gate a merge or a deploy), the test setup (what the real-database or end-to-end tests
need running and how to run one file), and the existing instruction files, so the new
blocks do not contradict them. Where they do, keep the repo's rule and note the conflict.
For more than 4 repos, give each repo to its own subagent (at most 3 at a time) with
`project-block.md` and `INVARIANTS.md`, and have it return the filled block, the drafted
invariants and the conflicts; the main session writes the files. Say first how many agents
that is and roughly what it costs.

Without the plugin, find the same facts by reading: AI tool files (`AGENTS.md`,
`CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md`, `GEMINI.md`), CI config
(`.github/workflows/`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.circleci/`,
`azure-pipelines.yml`), tests and what they need, monitoring (Sentry, Datadog,
OpenTelemetry), and where user-facing words live (UI strings, emails, help, docs, website,
legal and pricing pages, other repos included).

## 2. Ask only what the code cannot tell you

In one message, only what matters and is not inferable:

- **Heavy runs.** May sessions start databases, browsers, media tools or full builds without
  asking? Any memory or time limit, or a wrapper they must go through? (Default: ask before
  each heavy run.)
- **Which repos have a UI** (propose the survey's guess, and why), and whether a design tool
  is wanted on them (see step 6).
- **Which depends on which**, proposed from what you read (for example "web and mobile call
  api's HTTP API"; "the website shows the app's pricing").
- **Repo hooks** (*plugin*, main folder): list each distinct repo hook once (group by
  `contentKey`), with its event, matcher, command, the script it runs and what it does
  (read the script). For each, ask whether first-pass should run it from the main folder,
  and whether it applies to the whole session (a mode or a guard, like a ticket guard) or
  only to files in its repos (a formatter, a linter, a design check). A files hook on Bash
  sees a command as its repo's only when the command names the repo (`git -C <repo> ...`,
  or a leading `cd <repo> &&`); a session hook applies to every repo.
- **The profile block** holds a default reply style (answer first, short, plain words).
  Install it? (Default: ask; never in a file teammates share.)
- **Habit words**, with the profile: may the `habit-words` skill read the owner's last 20
  Claude Code sessions (only what they typed; pasted text, tool output and anything that looks
  like a key left out) to find the words they write that make answers worse, and map each to
  the checks it should mean? (Default: ask. No: the default words block.)
- **Teammates**, per repo: do other people open this repo on its own, without the main
  folder? Then its own file also carries the rules block (the owner loads it twice), and
  the breaker is copied into it for teammates without the plugin.

## 3. The workspace root

Write `AGENTS.md` at the root (Cursor, Codex and most agents read it) with, in this order:

1. the rules block, `assets/rules-block.md`, verbatim;
2. the profile block, `assets/profile-block.md`, verbatim, if the owner wants it;
3. with the profile, the words block: the `habit-words` skill's, if the owner agreed to have
   their sessions read (run it now, steps 1 to 6), otherwise `assets/words-block.md`
   verbatim. A words block whose marker says `through` is the owner's own: keep it. One
   whose marker says `default` is managed like the other blocks: replace it (with the
   skill's block if the owner now agrees);
4. in a main folder, the workspace block, `assets/workspace-block.md`, filled: a one-line summary, one table row
   per repo (what it is in a few words, stack, UI yes/no, and its group when the repos fall
   into groups the owner named, such as two companies; drop the Group column otherwise),
   which depends on which, and the hooks first-pass runs.

In one-repo mode the root is the repo, a file teammates share: the profile and words blocks
go in `~/.claude/CLAUDE.md` instead, and only the rules block goes in the repo.

Each block sits between its markers. If a block is already there, replace it (that is how
updates work); never edit text outside the markers, where the owner keeps their own rules.
Then `CLAUDE.md` at the root:

- missing: create it with the single line `@AGENTS.md`;
- already imports `@AGENTS.md`: nothing to do;
- exists without that import: add `@AGENTS.md` as its first line, and report every block of
  its own text that now repeats or contradicts the rules.

Once this root CLAUDE.md exists, Claude Code loads a repo's AGENTS.md only when that repo's
CLAUDE.md imports it (tested on Claude Code 2.1.280): step 5 makes sure every repo's does.

## 4. The workspace file (*plugin*, main folder)

Write `.first-pass/workspace.json`, then stamp it:

```json
{
  "firstPass": 1,
  "repos": [
    { "name": "api", "path": "api", "ui": false },
    { "name": "web", "path": "web", "ui": true },
    { "name": "site", "path": "../site", "ui": true }
  ],
  "ignore": ["scratch-repo"],
  "hooks": [
    {
      "id": "ticket-guard", "from": "api", "scope": "session",
      "events": { "UserPromptSubmit": "", "PreToolUse": "Edit|Write|MultiEdit|NotebookEdit|Bash" },
      "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/ticket-guard.js\"",
      "approve": true
    }
  ]
}
```

- `repos`: every repo the survey found that the owner keeps, `path` relative to the root.
  `ignore`: repos in the folder to leave out.
- `hooks`: one entry per approved hook: `events` maps each event to its matcher ("" for
  all), and `command`, `args`, `shell` and `timeout` are copied from the repo's settings
  exactly. `${CLAUDE_PROJECT_DIR}` means the repo the hook runs for; `${FIRST_PASS_WORKSPACE}`
  means the root. Scope `session` runs from `from` on every matching event; scope `files`
  runs only for tool calls on files in `repos` (default `[from]`) and, on Stop, once for each
  of them the session edited, from that repo's folder.
- `sameAs`: when the survey shows the same hook (same `contentKey`) in several repos, write
  one entry, `from` one of them, and list the others in `sameAs`. A session started inside
  any of them then gets that repo's own copy from Claude Code, and first-pass does not run
  it a second time.
- first-pass runs hooks on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop;
  tool hooks for Edit, Write, MultiEdit, NotebookEdit, Bash and PowerShell; never async.
  A repo hook outside that cannot be bridged: `record` refuses it, and the report says so.

Then run `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" record .`. It stamps each hook
marked `"approve": true` with the hash of its definition and of every file in the folder of
each script it runs, plus the repo's commit (a changed file pauses the hook until it is
approved again), records each repo's CI hash and hooks hash (so a later change is noticed),
and the plugin version. It never replaces a CI hash that changed: once a repo's section has
its CI line updated (step 5), run `record . --ci <repo>`.

To re-approve a paused hook, show the owner what changed first:
`git -C <repo> diff <the approved commit> -- <the pinned files>`, then set `"approve": true`
again and run `record`.

If the root's own `.claude/settings.json` already runs a repo hook by hand (a copy lifted
up earlier), report it: once first-pass runs that hook, the copy runs it a second time.
Remove it only with the owner's yes.

## 5. Each repo

First, the file the repo's section goes in, the same on every run: the file that already
holds its `first-pass:project` block; otherwise `AGENTS.md` if the repo has one (every
tool reads it); otherwise `CLAUDE.md`. Then make sure Claude Code loads it: the repo's
`CLAUDE.md` starts with `@AGENTS.md` whenever the repo has an AGENTS.md (create a
`CLAUDE.md` holding just that line if there is none). `@INVARIANTS.md` goes once, in the
same file as the section (in AGENTS.md it loads through CLAUDE.md's `@AGENTS.md`, tested).
When CLAUDE.md and AGENTS.md are one file (the survey's `claudeMdIsAgentsMd`: a hard link or
a symlink), writing either rewrites both: never replace one with an import of the other.
Write the section and `@INVARIANTS.md` once, into that file, appending in place with the
shell (`>>`, `Add-Content`): the Edit and Write tools save a new file, which splits a hard
link into two (tested on Windows). Then run the survey again and check `claudeMdIsAgentsMd`
is still true; if the link split, the old name holds the old text: put the link back
(`ln -f AGENTS.md CLAUDE.md`, or on Windows delete CLAUDE.md and
`mklink /H CLAUDE.md AGENTS.md`), and say so in the report.
One exception: a repo that is itself a Claude Code plugin (it has
`.claude-plugin/plugin.json`) gets no CLAUDE.md, because `claude plugin validate --strict`
rejects one at a plugin's root. Its section goes in AGENTS.md, which the breaker reads;
say in the report that Claude Code does not load it on its own.

- **Project block.** `assets/project-block.md`, its `{{...}}` placeholders filled with exact
  commands and paths, not descriptions: CI's checks as the commands CI runs, one test file,
  the real tests and what they need running and how to stop it, test limits (from the
  repo's own rules), heavy-run rules, monitoring, where its words live (sibling repos
  included), the same job done in two places (every pair you found: two delete paths, a
  webhook and a reconcile job, two clients for one vendor), extra pre-mortem cases the repo
  has (its queue's retry, its second worker, its own endings), and owner rules already
  written in the repo. Unknown stays as "unknown: <what to find out>". When the owner keeps
  groups of repos apart (two companies that must not be linked), a repo's files never name a
  repo of another group, even where code is shared or copied: say it in the report instead.
  If a `first-pass:project`
  block exists, leave it (it belongs to the team now) and only report what looks out of
  date, with one exception: when the survey or the start-of-session check says the repo's CI
  changed, rewrite that block's CI line from the CI files (show the owner the old and new
  line) and then run `record . --ci <repo>`.
- **Rules block** only in one-repo mode, or for a repo teammates open on its own: the same
  block as the root, verbatim. Never the profile or words block in a file teammates share;
  in one-repo mode those go in `~/.claude/CLAUDE.md`.
- **Invariants.** If `INVARIANTS.md` exists, do not overwrite it; suggest additions in the
  report. Otherwise start from `assets/INVARIANTS.md` and draft 6 to 12 from the code:
  1. From this catalogue, keep the ones that apply and restate each in the system's own
     terms (not "a side effect", but "an invoice email is sent once per invoice"):
     - An outside side effect (post, email, SMS, payment, webhook out) happens at most once
       per intent, and one that happened is recorded as happened.
     - A charge happens once per unit of work, a refund at most once, back to where it came from.
     - Every outside call has a deadline; paid vendor work runs once per request.
     - A background job survives a deploy or a crash: it finishes once or runs again, never
       dropped, never two copies at once.
     - Work is marked done only after it is done.
     - Limits and "not twice" rules are enforced by the database (a constraint or a
       conditional update), not by read-then-write.
     - A failure never looks like "nothing": the user sees an error and a way to retry, and
       no code writes after a failed read.
     - Every failure that affects a user reaches that user, and every swallowed error
       reaches monitoring.
     - Deleting an account or a record deletes everything the privacy policy says it does,
       stored files and third-party grants included.
     - Every sentence users, customers or regulators read is true of the code.
     - Nothing reads a request body before auth and size are checked; tokens are single-use.
     - Dates and times are in the user's (or account's) timezone everywhere.
     - Every query is scoped to the caller's tenant.
     - A field another repo reads keeps its meaning: API, event and export contracts change
       in every consumer together.
  2. Add 2 to 4 domain invariants the code implies ("an order's total equals the sum of its
     lines", "a time slot has at most one confirmed booking").
  3. For each, search the code for what holds it and fill **Held by** with file:line (or
     "convention only" / "nothing yet"). Fill **Known breaks** only with breaks you actually
     found while looking, with file:line; otherwise "none known". Do not audit here.
- **Cursor rules.** If the survey lists `.mdc` imports (Claude Code never loads them): *plugin*
  `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" cursor-rules <repo>` points each import at
  a generated `.md` copy in `.claude/cursor-rules/` and writes the copies; the start-of-session
  check then reports any copy that falls behind its `.mdc`. Without the plugin, write the
  copies by hand (the `.mdc` text without its frontmatter).
- **The breaker.** With the plugin it is `first-pass:breaker` in every session; nothing to
  install. Without the plugin (a skills install in Cursor or another tool), copy
  `assets/breaker.md` to `.claude/agents/breaker.md` in the folder sessions start in (the
  root in a main folder). Also copy it into a repo teammates open on its own. If a different
  `breaker.md` is already there, leave it and report the difference: a repo's own agent is
  only found by a session started inside that repo.

Claude Code treats `.claude/` as protected and asks before writing there: ask for that
approval rather than skipping the step. If it is refused, or the session cannot ask (a
headless run), report it under "Not done" with the exact command.

## 6. A design tool on the UI repos (optional)

If a design skill with its own hooks is installed in one repo (for example Impeccable in
`<repo>/.claude/skills/impeccable`), it only works for sessions started in that repo. Offer:

- install it at the root with its own installer (Impeccable:
  `<repo>/.claude/skills/impeccable/scripts/impeccable install --project --providers=claude -y --no-hooks`
  run from the root), so its skill and agents load in every session from the start;
- one `files` hook in `workspace.json` for the UI repos, running its hook command from the
  root copy, for example
  `{ "id": "impeccable", "scope": "files", "repos": [<UI repos>], "events": { "PostToolUse": "Edit|Write", "Stop": "" }, "command": "\"${FIRST_PASS_WORKSPACE}/.claude/skills/impeccable/scripts/impeccable\" hook", "timeout": 30, "approve": true }`.
  Its end-of-turn pass only finds the session's edits when run from the edited repo's
  folder, which is what a `files` hook does;
- not approving that repo's own copy of the same hook, so it does not run twice.

Its commands then run from inside the project being designed: say so in the root
`CLAUDE.md` (outside the markers), with the script's full path.

## 7. Check your own work

- Re-read every file you wrote: each block exactly once per repo across its CLAUDE.md and
  AGENTS.md together (not per file), markers balanced, no `{{` left, and `@AGENTS.md` in
  every repo CLAUDE.md whose repo has an AGENTS.md.
- If a repo formats or lints Markdown in CI (Prettier, markdownlint), run that check on the
  files you wrote in it and fix what it reports.
- *Plugin:* `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" check .` prints nothing out of
  date, or explain each line it prints.
- If a CLI is available, confirm a fresh session loads the rules from the root and a repo's
  block once a file in it is read, for example
  `claude -p "Without tools: quote pre-mortem question 2 from your instructions"` at the root,
  and `claude -p "Read <repo>/package.json, then quote that repo's CI checks line from your instructions"`.

## 8. Report

```
first-pass <version> set up in <folder> (<main folder with N repos | one repo>)
Written: <file> (created | block added | block updated | import added), one per line
Hooks run from the main folder: <id: scope, repos>, or "none"
Habit words: <n> mapped from <n> sessions | the default list | not installed
Invariants: <n> drafted in <repo>/INVARIANTS.md, review before relying on them (one line per repo)
Real tests: <per repo: what exists, or "none: the biggest gap">
Verified: <command> → <result>
Not done: <each step that could not run, and the command to finish it>
Conflicts with existing rules: <each, or "none">
Duplicates to remove (with your yes): <each hand-made copy of a hook or rule, or "none">
Teammates: Claude Code, `/plugin marketplace add joetawil7/first-pass` then
`/plugin install first-pass@first-pass`; Cursor, `npx skills add joetawil7/first-pass -a cursor --copy`
Nothing committed.
```
