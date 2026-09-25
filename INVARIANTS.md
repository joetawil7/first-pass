# Invariants

What this system must never break, whatever the feature. Every change is checked against the
ones it touches (the pre-mortem names them; the breaker checks them). Each invariant says what
holds it today and where it is known to break.

- When a fix lands, move its id out of "Known breaks".
- When a new break is found, add it.
- An invariant held only by convention is a candidate for a check that makes breaking it fail CI:
  a test, a lint rule, a database constraint, or a shared helper that is the only way to do the thing.

1. **first-pass never runs a repo hook the owner did not approve, or one whose pinned files changed since.**
   Held by: `whyPaused` in `scripts/lib/fingerprint.mjs`, checked before every run in
   `scripts/lib/bridge.mjs` (`runHook`); tests in `test/lib.test.mjs` and `test/hooks.test.mjs`.
   Known breaks: a hook whose command names no file it can find pins nothing (`record` warns).
2. **Every reply first-pass prints is one JSON object Claude Code accepts, and a failing hook it runs is shown, never swallowed.**
   Held by: `merge` in `scripts/lib/merge.mjs` (bad JSON, crashes and timeouts become a
   `systemMessage`); tests in `test/lib.test.mjs`.
   Known breaks: none known.
3. **A hook first-pass runs always answers before Claude Code's own limit for that event.**
   Held by: `EVENT_LIMITS` and `effectiveTimeout` in `scripts/lib/bridge.mjs`, and the test that
   compares them with `hooks/hooks.json`.
   Known breaks: none known.
4. **A repo's own hooks run once per event: never also by first-pass in a session Claude Code already runs them in.**
   Held by: `nativelyCovered` in `scripts/lib/bridge.mjs` (with `sameAs` for copies);
   `test/hooks.test.mjs`.
   Known breaks: none known.
5. **The managed blocks setup writes are the assets verbatim, once per repo, and a re-run keeps the owner's own text.**
   Held by: convention only (`skills/setup-first-pass/SKILL.md` steps 3, 5 and 7); CI checks the
   assets' markers and versions, not what setup writes.
   Known breaks: none known.
6. **The rules, profile and words blocks carry the plugin's version.**
   Held by: the "Managed block versions match plugin.json" step in `.github/workflows/validate.yml`.
   Known breaks: none known.
7. **Nothing in the repo names the private projects first-pass came from.**
   Held by: the "No private project names" step in `.github/workflows/validate.yml`.
   Known breaks: none known.
8. **The user's prompts leave their transcripts only as what they typed (plus the redacted end of the reply before a pushback), with secret-looking text replaced, in temp files that only `words --delete` or a later run's 6-hour sweep removes, and nothing else writes to.**
   Held by: `typedText`, `cleanPrompt`, `redact` (applied before any cut), `writeWordsFile`,
   `deleteWordsFile` and `removeStaleWordsFiles` in `scripts/lib/words.mjs`;
   `test/words.test.mjs` (row kinds, redaction cases, delete refuses other and missing files,
   the sweep keeps recent and look-alike files).
   Known breaks: redaction is pattern-based, so a secret with no label, no digit and no
   symbol (a long plain lowercase word) is kept; the skill is told never to quote one. Text a
   user types when rejecting a tool call is stored inside a tool result and is left out
   (its stored shape is not verified).
