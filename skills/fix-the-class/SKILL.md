---
name: fix-the-class
description: Bug-fix routine that fixes the whole class of bug, not just the reported instance. Use for any bug report, failing production behaviour, monitoring alert, audit finding or review finding, and whenever the same kind of bug has been seen before. Reproduces it with a failing test, names the failure class, searches the codebase for the same pattern, fixes or records every hit, and adds the rule, invariant, helper or check that stops it coming back.
---

# fix-the-class

A fix that guards only the spot where the bug was found invites the same bug in the next
feature. Audits that find the same bug twice are the sign. Fix the instance, then the
class.

## 1. Reproduce

Write a test that fails the way the report says, at the lowest layer that reproduces it end
to end (see `ship-check` step 2). No test, no fix: if it cannot be reproduced, say what was
tried and stop.

## 2. Name the class

Which pre-mortem question did the original change fail? Twice, halfway, outside call,
failure-is-not-empty, neighbors, endings, money, hostile user, words, scale and time. Which
invariant in `INVARIANTS.md` does it break? If none fits, the invariant is missing: draft it.

State the pattern in one sentence that can be searched for, for example:

- "a status check outside the transaction that then writes" (twice)
- "a done-marker saved before the work" (halfway)
- "a vendor call with no timeout" or "a committing call retried on 5xx" (outside call)
- "a query result checked for loading but not for error" (failure is not empty)
- "the delete path skips what the disconnect path releases" (neighbors)
- "a refund with no record of which charge it refunds" (money)

## 3. Search for the pattern

Search the whole codebase for other instances: the repo, and in a main folder every repo
the workspace section says shares the code, data or vendor (the same bug is often copied
between a web app and a mobile app, or between two services calling one vendor). Examples
by class:

- **Twice**: read-then-write on the same row (`find` then `update` without a lock or
  conditional `WHERE`), counts compared to limits before inserting.
- **Halfway**: `status = 'done'` / `sent = true` / `claimed` written before the call it
  describes.
- **Outside call**: `fetch` calls, HTTP client calls and SDK constructors without a
  timeout option; retry wrappers around calls that commit.
- **Failure is not empty**: `catch` blocks that return `[]`, `null` or a default; UI
  queries that read `isLoading` and not `isError`.
- **Neighbors**: every writer of the field or status involved; every path that does the
  same job (all delete paths, all clients of the vendor, all branches by type).
- **Money**: every refund or credit path; every paid call and its cap.
- **Scale and time**: queries without a limit; `new Date()` or calendar-month math where a
  user's timezone or a billing period is meant.

List every hit with file:line and a verdict: same bug, safe (why), or unsure.

## 4. Pre-mortem the fix

The fix is a change too, and it can break something the bug never touched: a lock that
leaves an order stuck when the vendor fails, or a guard that also blocks a second payment
the customer really meant. Before the first edit to the fix (the failing tests from step 1
come first), run the `premortem` skill on the fix and on the fixes planned for the other
hits, sized by its own rules. Its ten questions go against the fixed code, the bug's own
question included: step 2 named it for the old code, and here the answer says what now
stops the bug in every form it takes (for a double charge: two tabs, a retry, two
instances). If a pre-mortem of this fix was written earlier in the session, point to it
and add what it does not cover: the other hits' fixes, and anything about the fix that
changed since. A pre-mortem of other work, such as the feature the bug is in, does not
count.

## 5. Fix or record every hit

- Same bug and in scope: fix it, each with a failing-first test.
- Same bug but out of scope: add it to `INVARIANTS.md` Known breaks (or the team's issue
  tracker) with file:line.

## 6. Make it hard to do again

Pick the strongest prevention that fits, and propose or build it:

1. **A shared helper that is the only way to do the thing** (one vendor-call function that
   always sets a timeout and an idempotency key; one refund function keyed by the charge;
   one claim function that fails on 0 rows; one delete path used by every caller).
2. **A database constraint** (a unique index that makes "twice" impossible).
3. **A check that fails CI** (a lint rule or test that finds the pattern, like a vendor call
   without a timeout).
4. **An invariant** in `INVARIANTS.md`, with what now holds it.
5. **A rule** in the project's instruction file, as a last resort: rules are advisory,
   checks are enforced.

A prevention you build is part of the fix: add it to the step 4 pre-mortem before building
it.

## 7. Finish with ship-check

Run the `ship-check` skill. The report adds:

```
Class: <pre-mortem question> / <invariant>
Pattern: <the searchable sentence>
Other hits: <n fixed, n recorded, n safe>, each with file:line
Prevention: <helper | constraint | check | invariant | rule>, and where
```
