---
name: setup-first-pass
description: Set up first-pass in the current repository. Writes the shipping rules (pre-mortem, evidence-based definition of done, fix-the-class) into the instruction files the repo's AI tools always load (AGENTS.md, CLAUDE.md), fills in this project's real test and CI commands, drafts INVARIANTS.md from the code, and installs the breaker reviewer agent. Use when asked to set up, install, add or update first-pass in a project, or to "add the shipping rules" to a repo. Re-run to update the rules to a newer version.
allowed-tools: Read Glob Grep
---

# setup-first-pass

Installs first-pass into this repository so every session, in every tool the team uses,
starts with the rules.

The files this skill copies are in its own folder, `${CLAUDE_SKILL_DIR}/assets/`:
`rules-block.md`, `project-block.md`, `INVARIANTS.md` and `breaker.md`. (Claude Code fills
in that path. In other tools it is the folder this SKILL.md was loaded from.) Read them
from there and copy them exactly; never write them from memory. If they cannot be read,
stop and say so.

Nothing is committed, pushed or branched: the owner reviews and commits.

## 1. Survey (read only)

Find out, with file:line evidence:

- **AI tools in use.** Which exist: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`,
  `.cursor/`, `.agents/skills/`, `.claude/`, `.codex/`, `GEMINI.md`,
  `.github/copilot-instructions.md`. Note any file that `@`-imports another.
- **CI's checks.** Read the CI config (`.github/workflows/`, `.gitlab-ci.yml`,
  `bitbucket-pipelines.yml`, `.circleci/`, `azure-pipelines.yml`, ...). List the exact
  commands each required job runs (format, lint, typecheck, build, unit, integration,
  end-to-end), and which jobs gate a merge or a deploy if the config shows it.
- **Real tests.** Which tests hit a real database, queue or browser (integration, flow,
  end-to-end), where they live, the command to run one file, and what they need running
  (docker compose files, test containers, seed scripts). If there are none, say so: it
  is the most important gap to report.
- **Monitoring.** Sentry, Datadog, Bugsnag, OpenTelemetry, or logs only.
- **Words.** Where user-facing text lives: UI strings or i18n files, emails, help center,
  docs, marketing site, legal and pricing pages (including other repos if the code refers
  to them).
- **Existing rules.** Read the current instruction files so the new block does not
  contradict them. Where it does, keep the project's rule and note the conflict.

## 2. Ask only what the code cannot tell you

Ask the owner, in one message, only for what matters and is not inferable. Usually:

- **Heavy runs.** May sessions start databases, browsers, media tools or full builds on
  this machine without asking? Any memory or time limits? (Default if not answered: ask
  before each heavy run.)
- **Team or personal.** Should the files be committed for the whole team (default) or
  kept local?

Do not ask about anything in step 1.

## 3. Write the rules into every always-loaded instruction file

The block is `assets/rules-block.md`, verbatim. It sits between
`<!-- first-pass:rules:start` and `<!-- first-pass:rules:end -->`.

- **AGENTS.md** (read by Cursor, Codex and most other agents): create it if missing. If a
  first-pass rules block is already there, replace it (that is how updates work).
  Otherwise append the block at the end.
- **CLAUDE.md** (read by Claude Code):
  - missing: create it containing the single line `@AGENTS.md`.
  - already imports `@AGENTS.md`: nothing to do.
  - exists without that import: add the same block there too (replace or append, as
    above), so Claude Code gets the rules without importing the rest of AGENTS.md.
- **Other always-loaded files the repo already uses** (`GEMINI.md`,
  `.github/copilot-instructions.md`): same block, same way.
- **Cursor project rules**: if the repo keeps its always-on rules only in
  `.cursor/rules/*.mdc` and has no AGENTS.md, still write AGENTS.md: Cursor reads it
  automatically.

Every always-loaded file ends up with the block exactly once. Never edit text outside the
markers.

## 4. Fill in the project block

Right after the rules block, in each file that got the rules block in step 3 (not a
CLAUDE.md that only imports `@AGENTS.md`), add `assets/project-block.md` with
its `{{...}}` placeholders filled from steps 1 and 2: exact commands, not descriptions.
If the file already has a `first-pass:project` block, leave it as it is (it belongs to the
team now) and only report what looks out of date.

## 5. Draft INVARIANTS.md

If `INVARIANTS.md` exists, do not overwrite it; suggest additions in the report. Otherwise
start from `assets/INVARIANTS.md` and draft 6 to 12 invariants from the code:

1. From this catalogue, keep the ones that apply to this system and restate each in its
   own terms (not "a side effect", but "an invoice email is sent once per invoice"):
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
2. Add 2 to 4 domain invariants the code implies (for example "an order's total equals
   the sum of its lines", "a time slot has at most one confirmed booking").
3. For each, search the code for what holds it and fill **Held by** with file:line (or
   "convention only" / "nothing yet"). Fill **Known breaks** only with breaks you actually
   found while looking, with file:line; otherwise "none known". Do not audit the codebase
   here: that is a separate job.

Mark the file as a draft in the report: the owner reviews it before relying on it.

## 6. Install the breaker agent

Copy `assets/breaker.md` to `.claude/agents/breaker.md` (Claude Code and Cursor both read
that folder). If a file is already there: identical, skip; different, leave it and report
the difference. Mention that Claude Code users who installed the first-pass plugin also
have it as `first-pass:breaker`.

Claude Code treats `.claude/` as protected and asks before writing there: ask for that
approval rather than skipping the step. If it is refused, or the session cannot ask
(a headless run), report it under "Not done" with the exact copy command.

## 7. Check your own work

- Re-read every file you wrote. Each always-loaded file has exactly one rules block and at
  most one project block, markers balanced.
- If the repo formats or lints Markdown in CI (Prettier, markdownlint), run that check on
  the files you wrote and fix what it reports.
- If a CLI is available, confirm a fresh session loads the rules, for example
  `claude -p "Without using tools: quote pre-mortem question 2 from your instructions"`.

## 8. Report

```
first-pass <version> set up in <repo>
Written: <file> (created | block added | block updated), one per line
Invariants: <n> drafted in INVARIANTS.md, review before relying on them
Real tests: <what exists, or "none: the biggest gap">
Verified: <command> → <result>
Not done: <each step that could not run, and the command to finish it>
Conflicts with existing rules: <each, or "none">
Teammates: Claude Code, `/plugin marketplace add joetawil7/first-pass` then
`/plugin install first-pass@first-pass`; Cursor, `npx skills add joetawil7/first-pass -a cursor --copy`
Nothing committed.
```
