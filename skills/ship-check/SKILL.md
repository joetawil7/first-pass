---
name: ship-check
description: The definition of done. Run before calling any change done, fixed, verified, ready or shippable, for features and bug fixes alike. Checks the pre-mortem was answered, proves the tests fail on the old code, gets a fresh breaker review, runs CI's own checks in a clean checkout, checks the user-facing words, and writes the evidence report. Also use when asked "is it done", "is it ready", "did you verify it" or "can we merge".
---

# ship-check

Walk every step. A step you cannot do goes in the report under "Not verified" with the
reason; it is never skipped silently. The project's commands are in the `first-pass:project`
block of its instruction file (AGENTS.md or CLAUDE.md); if there is none, read them from
the CI config and say so in the report.

## 1. Pre-mortem

Find the pre-mortem in the plan. If there is none, write it now from the diff with the
`premortem` skill, and say in the report that it was written after the code. Search again
for neighbors of every field, status, option, queue and endpoint in the diff; add any the
plan missed.

## 2. Tests that fail on the old code

For each behaviour the change adds or fixes, and each pre-mortem answer of the "test" kind:

1. **Right layer.** The lowest layer that reproduces it end to end. If the bug could live
   in a query, a transaction, a queue or a browser, the test runs against the real thing
   (an integration test on a real database, an end-to-end test in a browser). A unit test
   with mocks is enough only for pure logic.
2. **Fails first.** In a clean checkout of the code before the change. That is the base:
   HEAD when the change is still uncommitted, otherwise the commit the branch started from
   (`git merge-base HEAD origin/<main branch>`). Never a checkout that already contains
   the change, or good tests pass on the "old" code and look worthless.
   ```
   git worktree add --detach ../<repo>-shipcheck <base>
   ```
   Copy in only the new or changed test files, install dependencies as CI does, run them,
   and record which fail and why. Then copy in the change and record that they pass. A test
   that passes on the old code proves nothing about the change: rewrite it.
3. **Guards** (tests that behaviour which must not change still holds) pass on both. Say
   which tests are guards.
4. **The risky answers get a test.** When the change has a queue job, a paid call, a
   publish, a payment or a delete in its path: one test runs it twice at once, one makes the
   outside call time out or return a 5xx.
5. **Tests assert what the user sees or what is stored**, not only that a new test id
   exists or that a mock was called.

## 3. Fresh review

Hand the change to the `breaker` agent (Claude Code: `breaker`, or `first-pass:breaker`
from the plugin; Cursor: `/breaker`) with what the change is for, the base ref or file
list, and the pre-mortem. It must run in its own context. If your tool cannot start one,
ask the user to run the breaker in a new chat; never review in the context that wrote the
code.

For each finding:

- Real (CONFIRMED, or PLAUSIBLE and you confirm it): fix it, with its own failing-first
  test (step 2).
- Disagree: say why in the report, with file:line.
- Real but out of scope: list it under Open.

If the fixes were more than small, run the breaker again on the new diff.

## 4. CI's own checks, in the clean checkout

In the step 2 worktree with the whole change copied in, run exactly the commands CI runs
(format, lint, typecheck, build, unit tests, integration and end-to-end tests the change
touches; the whole integration suite when the change touches jobs, payments, publishing,
deletion or auth). Follow the project's rules for heavy runs.

A failure that also happens on the base without the change is pre-existing: name the test
and move on. Then remove the worktree (`git worktree remove --force <path>`) and any leftovers,
including copied env files.

## 5. Monitoring

List what now reaches monitoring and at what level. Every error the change swallows is
reported at a level someone will see. For a bug fix, consider a tripwire: a report that
fires if the exact failure ever happens again.

## 6. Words

Search UI strings, emails and notifications, help, docs, and pricing and legal pages for
sentences about what changed. Each is confirmed true or changed. Changes to legal, pricing
or public copy get their own line in the report.

## 7. Invariants

For each invariant in `INVARIANTS.md` the change touches: held, or broken (add it to Known
breaks). If the change fixes a known break, move its id out.

## 8. Report

```
<What changed, one line>
<file:line>: <what it does now>
Verified: <command> → <result>, one per line (fail-before and pass-after counts)
Breaker: <n findings: fixed / disputed / open>
Not verified: <each thing, and why>
Not handled, because: <each, from the pre-mortem>
Public copy changed: <file, or "none">
Open: <follow-ups>
```

"Verified" only ever sits next to a command and its result. If any step above was skipped,
the change is not done: say "not done" and why, not "done with caveats".
