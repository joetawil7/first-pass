---
name: premortem
description: Run before writing or changing code for any feature, bug fix or refactor that touches data, jobs, money, outside services or user-facing behaviour. Finds where the change will break before it is built, by walking ten named failure classes (twice, halfway, outside call, failure-is-not-empty, neighbors, endings, money, hostile user, words, scale and time) against the code, and writes the answers into the plan. Use when planning a change, when asked to "think it through", "cover the gaps", "make sure it's bug free", or before any edit to payment, publishing, deletion, auth or background-job code.
---

# premortem

Assume the change shipped and broke. Find out where, before writing it.

"Be careful" does nothing: it names no place to look. These ten questions name places. Each
answer is one of three things, and nothing else counts:

- **file:line** showing it is already handled,
- **the test** that will prove it (named now, written with the change), or
- **"Not handled, because ___"**, a reason the owner can accept or reject.

"N/A" is allowed only with the reason: "Twice: N/A, the handler is a pure read".

## Size it to the change

- A copy or style change: one line covering all ten ("Words: checked X; rest N/A, no data
  or behaviour change").
- A normal feature: a line or two per question.
- Money, publishing, deletion, auth, background jobs, anything irreversible: a paragraph per
  question, and read the code for each, don't answer from memory.

## 0. Map what the change touches

List every field or column, status value, option key, queue or topic, cron, event, endpoint,
DTO property and outside service the change reads or writes. This list drives questions 1 to 10.

Name the repo each item lives in. In a main folder with many repos, the workspace section of
the root `AGENTS.md` or `CLAUDE.md` says which repos use this one (a web app and a mobile app
calling an API, a website quoting the app's prices): their readers are neighbors too. Read
the repo's own section (its `first-pass:project` block) for extra cases and for the same job
done in two places.

## 1. Twice

What happens when this runs two times: double-click, two tabs, the client retrying, the
job queue retrying after a timeout, two instances of the worker, a webhook delivered again?

- Find the guard: a unique constraint, an idempotency key, a conditional update whose
  affected-row count is checked (`UPDATE ... WHERE status = 'queued'`, 0 rows means stop), a
  lock held across the whole check-and-write.
- Read-then-write with no lock is not a guard. An in-memory flag is not a guard once there
  are two processes.
- Test: fire the same call twice at once (`Promise.all`, parallel requests, a job run twice)
  and assert one effect.

## 2. Halfway

Walk the code write by write. If the process dies right after each one (a deploy, a crash,
out of memory), what state is left, and what does the retry do with it?

- A "done", "sent" or "claimed" marker written before the work means the retry skips work
  that never happened. Write it after, or in the same transaction.
- Two writes that must both happen belong in one transaction, or the second must be
  retryable from the first.
- Check the job's timeout against its longest real run: a job killed at its timeout while
  still working is retried while the first copy runs on.

## 3. Outside call

For every call to another service (API, vendor, email, payment, storage, model):

- **Deadline**: an explicit timeout. Library defaults are often minutes or none.
- **Ambiguity**: after a timeout, a dropped connection or a 5xx, could the call already
  have happened (posted, charged, sent)? If yes: an idempotency key, or look it up
  before retrying. Never retry a committing call blind.
- **Failure handling**: which errors are retryable, which are final, and does a final one
  reach the user?

## 4. Failure is not empty

- Can a failed load render as "nothing here", "not configured" or an empty list? The user
  must see an error and a way to retry.
- Can a failed read be treated as empty and then written back (a failed fetch of a list,
  then saving the list with one new item, erases the rest)?
- Every `catch` that swallows: does the error reach monitoring at a level someone will see?

## 5. Neighbors

For every item on the map from step 0, search the whole repo (backend, frontend, workers,
scripts, migrations, tests, docs) and every repo that uses it for other readers and writers:

```
grep -rn "<column_or_field>" --include=*.<ext> <repo> <each repo that uses it>
grep -rn "'<status_value>'" <repo>
grep -rn "<queue_or_event_name>" <repo> <each repo that uses it>
```

List each neighbor in the plan and say what it needs: nothing (why), a change, or a test.
Look hardest for the same job done in two places: two paths that delete, two clients for
one vendor, a webhook and a reconcile job, a single-item path and a bulk path, an API and
an admin script. The change usually updates one of them.

## 6. Endings

What does this do, and what happens to what it created, on: cancel, delete (the record and
the whole account), disconnect, reconnect, expire, downgrade, plan lapsed or cancelled,
trial end, replace? Is anything left running, charged, stored or promised?

## 7. Money

For every paid call (a vendor, a model, a third-party API) and every credit, quota or charge:

- Who pays, and what caps it? The cap must be enforced in the database, atomically.
- What refunds it on failure or cancel, can the refund run twice, does it go back where
  the charge came from?
- Does what the user pays cover what it costs, at the worst case, not the average?

## 8. Hostile user

- Is auth checked, and the size limited, before the input is read or buffered?
- Can a cap be beaten by parallel calls, or by delete-and-redo?
- Are links, tokens and OAuth states single-use and short-lived?
- Does any user-controlled text reach a prompt, a query, a shell, a file path or HTML
  without the matching guard?

## 9. Words

Search every place user-facing words live (UI strings, emails and notifications, help
center, docs, marketing, pricing and legal pages, API error messages) for sentences about
what this changes. Each is still true, or changes with the code. List them.

## 10. Scale and time

- Every query: a limit, and an index for its filter. Lists that stop at the first page
  (20, 50, 100 rows) silently hide the rest.
- Loops that run one query per row.
- Times: the user's or account's timezone, not the server's or the browser's. Periods:
  the billing period, not the calendar month. Daylight saving, month ends, leap days.

## Invariants

If the repo has `INVARIANTS.md`, name every invariant the change touches and how it stays
true. If the change creates a new rule the whole system must keep, add it there.

## Output

Put this in the plan, before the first edit:

```
Pre-mortem: <change>
Touches: <the map from step 0>
1 Twice: <file:line | test | Not handled, because ...>
2 Halfway: ...
3 Outside call: ...
4 Failure is not empty: ...
5 Neighbors: <each neighbor: what it needs>
6 Endings: ...
7 Money: ...
8 Hostile user: ...
9 Words: <each sentence: file, still true or changing>
10 Scale and time: ...
Invariants: <each touched, and how it holds>
Tests to write: <the list, each failing on the old code>
```

Every "Not handled, because" is shown to the owner before building, not buried in the plan.
