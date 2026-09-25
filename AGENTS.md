# first-pass

Claude Code does not load this file on its own here: a CLAUDE.md at a plugin root fails `claude plugin validate --strict`. The breaker and the working rules read it; read it before changing this repo.

<!-- first-pass:project:start (written once by the setup-first-pass skill; yours to edit, re-runs keep it) -->

### This repo (first-pass)

- **What it is:** first-pass itself: a Claude Code plugin (`.claude-plugin/`, `hooks/hooks.json`,
  `scripts/`) and a skills pack (`skills/`) that other tools install with `npx skills`. The
  setup skill's assets (`skills/setup-first-pass/assets/`) are the rules block, profile block,
  default words block, workspace block, project block, INVARIANTS template and the breaker
  agent. The `habit-words` skill reads the user's own session transcripts
  (`scripts/lib/words.mjs`). The `sharpen` skill runs only when the user types it
  (`disable-model-invocation`) and rewrites the prompt given with it; its gate
  (`scripts/lib/sharpen-gate.mjs`) holds back edits, shell commands, subagents, MCP tools,
  publishing, scheduling and other skills until the rewrite is shown.
- **CI's checks** (`.github/workflows/validate.yml`, job `validate`): `claude plugin validate
  --strict .` and on `.claude-plugin/plugin.json` (Claude Code pinned to 2.1.280), skill names
  match folders, every block has one start and one end marker, the rules, profile and words
  block versions equal `plugin.json`'s, the hooks point at scripts that exist,
  `node --test test/*.test.mjs`, and the private-name check.
- **Run one test file:** `node --test test/lib.test.mjs` (also `hooks.test.mjs`,
  `setup.test.mjs`, `words.test.mjs`, `sharpen.test.mjs`).
- **Real tests** (the layer that catches what mocks miss): `test/hooks.test.mjs` runs
  `scripts/hooks.mjs` the way Claude Code does, against throwaway main folders in the system
  temp folder. Before a release, an end-to-end run: `claude -p "/first-pass:setup-first-pass"`
  with `--plugin-dir .` on a fake main folder, then fresh sessions that check the rules load,
  a bridged hook denies, and the done check fires once.
- **What they need running, and how to start and stop it:** nothing; the tests create and
  leave temp folders only.
- **Test limits** (what never to run here, and how much at once): tests only ever write
  under the system temp folder; never point one at a real workspace, or at the real
  `~/.claude` (the tests set `CLAUDE_CONFIG_DIR` to a temp folder).
- **Heavy runs** (databases, browsers, media tools, builds): none.
- **Monitoring** (where a swallowed error must end up): a failing bridged hook becomes a
  `systemMessage` the user sees (`scripts/lib/merge.mjs`); a crash in first-pass itself is a
  Claude Code hook error.
- **Words live in:** `README.md`, every `skills/*/SKILL.md`, and the assets, which are loaded
  into every user's sessions once setup writes them.
- **The same job in two places** (a change to one needs the other): the timeouts in
  `hooks/hooks.json` and `EVENT_LIMITS` in `scripts/lib/bridge.mjs` (a test enforces it); the
  block versions in the assets and `plugin.json`'s version (CI enforces it); the setup skill's
  steps and `scripts/cli.mjs`'s subcommands; the survey's repo finder and the drift check's
  (`scripts/lib/repos.mjs`, shared); the words marker the `habit-words` skill writes and
  `WORDS_MARKER` in `scripts/lib/drift.mjs`; the default habit words and their checks in
  `skills/setup-first-pass/assets/words-block.md` and the table in `skills/sharpen/SKILL.md`;
  the PreToolUse matchers in `hooks/hooks.json` (a named list and `mcp__.*`) and
  `GATED_TOOLS`/`isGated` in `scripts/lib/sharpen-gate.mjs` (a test enforces it), and
  `gateOnly` in `scripts/hooks.mjs`, which keeps repo hooks off the tools only the gate needs; the word
  **Sharpened** in `skills/sharpen/SKILL.md` step 5 and `SHOWN` in the gate; the transcript row shapes `typedText` in
  `scripts/lib/words.mjs` knows and what Claude Code writes (a new row kind is silently left
  out or wrongly kept).
- **Extra pre-mortem cases** (this repo's own ways to run twice, end, or scale): a plugin
  update with an unchanged version is not picked up by `claude plugin update`, so every
  release bumps `plugin.json`; a change to a managed block reaches a user only when they
  re-run setup; users are on Windows, macOS and Linux (paths, shells, `\r\n`).
- **Owner rules:** never name the private projects first-pass came from (CI checks); the
  GitHub account is the owner's personal one, and nothing is pushed before the owner creates
  the repo.
- **Invariants:** `INVARIANTS.md`

<!-- first-pass:project:end -->

