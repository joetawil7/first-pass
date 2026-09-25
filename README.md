# first-pass

**Ship it right on the first pass.** Skills and a reviewer agent for Claude Code, Cursor and
other coding agents that replace "make sure it's bug free" with checks that change what the
agent actually does.

## Why

A production codebase was built feature by feature with an AI coding agent. On every
feature the agent was told: "make sure the code is correct and bug free, cover all gaps, be
100% sure." A full audit then found **318 issues, 25 of them high severity.**

Only 45 of them (14%) were mistakes in the lines being written. The rest were around those lines:

| Cause                                                             | Issues |
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

Several of them had already been found by earlier audits and fixed: each fix
patched one spot, and nothing turned the lesson into a rule the next session would load.

"Be careful" names no place to look, so it changes how sure the agent sounds, not what it
checks. What does change the output:

- **A named failure class** to walk (the pre-mortem's ten questions).
- **A test that must fail on the old code** before the change counts.
- **A reviewer that did not write the code.** Models are poor at catching their own
  mistakes in the context that made them ([Huang et al., 2024](https://arxiv.org/abs/2310.01798));
  a fresh context "won't be biased toward code it just wrote"
  ([Anthropic](https://code.claude.com/docs/en/best-practices)).
- **Checks over rules.** Instruction files are advisory; a constraint, a shared helper or a
  CI check is enforced.

## What's inside

| Piece              | What it does                                                                                                                    | When             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `premortem`        | Walks ten failure classes against the code; every answer is file:line, a test, or "Not handled, because ___"                    | Before code      |
| `breaker` (agent)  | Fresh-context adversarial review of the diff and of every other code path touching the same data; concrete findings only       | Before done      |
| `ship-check`       | Definition of done: fail-first tests, breaker, CI's checks in a clean checkout, words checked, an evidence report                | Before done      |
| `fix-the-class`    | Reproduces a bug, names its class, finds the same pattern elsewhere, adds the helper, constraint or check that stops it         | On any bug       |
| `setup-first-pass` | Writes the rules into the repo's AGENTS.md and CLAUDE.md with the project's real commands, drafts `INVARIANTS.md`, installs the breaker | Once per repo    |

## Install

### Claude Code: the plugin, for every project

```
/plugin marketplace add joetawil7/first-pass
/plugin install first-pass@first-pass
```

From a terminal: `claude plugin marketplace add joetawil7/first-pass`, then
`claude plugin install first-pass@first-pass`. To update: `claude plugin marketplace update first-pass`,
then `claude plugin update first-pass@first-pass`.

### Cursor and other agents

```
npx skills add joetawil7/first-pass -a cursor --copy        # this project
npx skills add joetawil7/first-pass -a cursor --copy -g     # every project
```

This installs the skills with the [skills CLI](https://github.com/vercel-labs/skills).

- Name your agent with `-a` (`-a codex`, `-a windsurf`, ...). `--all` installs into every
  agent the CLI knows: dozens of folders.
- Don't add `-a claude-code` if you use the plugin: you would get every skill twice.
- `--copy` writes real files instead of symlinks, which Windows checkouts turn into plain text.
- The breaker agent is installed into each project by the setup step. Claude Code and
  Cursor load it from there; in other tools, run it as a prompt in a new chat.

### Then, once in each repository

Run the setup skill: `/first-pass:setup-first-pass` with the Claude Code plugin,
`/setup-first-pass` elsewhere. It:

- writes the rules into `AGENTS.md` (Cursor, Codex and most agents read it) and `CLAUDE.md`
  (Claude Code), between markers, without touching the rest of either file;
- fills in the project's real commands: CI's checks, the real-database and end-to-end
  tests, what they need running;
- drafts `INVARIANTS.md`, the rules the whole system must keep, each with the code that
  holds it;
- copies the breaker to `.claude/agents/breaker.md`, which Claude Code and Cursor both read.

Review the files and commit them. Re-run setup to update the rules to a newer version; your
project section and `INVARIANTS.md` are kept.

### Teammates

Once the setup is committed, every teammate's agent loads the rules and the breaker from the
repo. The skills the rules point to are installed per person: the plugin for Claude Code, the
`npx skills` line for Cursor. A team that would rather commit the skills too can run the
`npx skills` line without `-g` and commit the folder it creates.

## How to work with it

1. **Plan.** Ask for the change. The agent runs the pre-mortem before editing. Read its
   "Not handled, because" lines: those are your decisions.
2. **Build.** With the tests the pre-mortem named, each failing on the old code first.
3. **Done.** `ship-check` runs the breaker, CI's checks in a clean checkout, and the words
   check, then reports `Verified: <command> → <result>` and what was not verified.
4. **Bug.** `fix-the-class`: the instance, every other instance, and the check that stops
   the next one.

Instead of "make sure it's bug free", say: *"Run the pre-mortem, show me the tests that fail
without the change, and list what you did not verify."*

## What it costs, and what it won't do

- **Slower per change.** A real test that fails first, a second agent's review, and CI's
  checks in a clean checkout take time and tokens. The trade is fewer loops after "done".
  The pre-mortem is sized to the change: a copy tweak answers it in one line.
- **It won't make code bug-free.** The goal is fewer and smaller escapes: no high-severity
  ones, no bug class found twice, audits that find tens of small items instead of hundreds.
  This is version 0.1: that goal is the design, not a measured result yet.
- **Rules alone decay.** The lasting fixes are the ones `fix-the-class` pushes toward:
  shared helpers that are the only way to do a thing, database constraints, CI checks.

## Further reading

- Huang et al., [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) (ICLR 2024)
- Tambon et al., [Bugs in Large Language Models Generated Code](https://arxiv.org/abs/2403.08937)
- CodeRabbit, [State of AI vs Human Code Generation](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)
- Anthropic, [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)

## License

[MIT](LICENSE)
