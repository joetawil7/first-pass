---
name: ship-check
description: The definition of done. Run before calling any change done, fixed, verified, ready or shippable, for features and bug fixes alike. Checks the pre-mortem was answered, proves the tests fail on the old code, gets a fresh breaker review, runs CI's own checks in a clean checkout, checks the user-facing words, and writes the evidence report. Also use when asked "is it done", "is it ready", "did you verify it" or "can we merge".
---

# ship-check

Walk every step. A step you cannot do goes in the report under "Not verified" with the
reason; it is never skipped silently. The repo's commands, test limits and heavy-run rules
are in the `first-pass:project` block of its instruction file (AGENTS.md or CLAUDE.md); if
there is none, read them from the CI config and say so in the report. Its test limits bind
every step below.

Run everything inside the repo that changed (`cd <repo>`, `git -C <repo>`), not from a main
folder above it. A change that spans repos walks the steps once per repo.

A prompt with several items walks steps 1 and 2 per item, while each is built, running only
the tests that item touches; one clean checkout of the base serves every item's fail-first
run. Steps 3 and 4 run once for all of them, after the last item is built: one review per
item (small items that touch the same code can share one), started together only where the
repo's test limits say side-by-side runs are safe (at most three at once), otherwise one
after another; and, while they run, CI's full checks in one clean checkout holding
every item (again after any later edit). The
report answers each item, and every item's list of smaller findings comes in it, once.

Nothing is pushed, merged, deployed, migrated or published until steps 3 and 4 are finished
for a clean checkout holding exactly what it ships (failures the base has too are named,
and findings left open are answered by the user first), unless the user says to ship it as
it is.

## 0. Size

A change with no logic in it (a comment, a doc, a spelling fix that changes no behaviour)
runs only the repo's format, lint and build checks, plus step 6 when a person reads the
text, and the report says this exception was used. Anything else, however small (a
constant, a condition, a default, a price, a label whose meaning changes), walks every step.
When unsure, it is not a typo.

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
   git -C <repo> worktree add --detach "<temp dir>/<repo>-shipcheck-<short base sha>-<time>" <base>
   ```
   Put it in the system temp folder, not beside the repo (a new folder inside a main folder
   looks like a new repo to every tool that scans it), under a name no parallel session
   will pick.
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

Hand the change to the `breaker` agent (Claude Code: `first-pass:breaker` from the plugin,
or `breaker` where a repo installed its own; Cursor: `/breaker`) with what the change is
for, the repo, the base ref or file list, the pre-mortem, and the task's scope (or that the
user lifted it with `hulk`). It must run in its own
context. If your tool cannot start one, ask the user to run the breaker in a new chat;
never review in the context that wrote the code.

Start it in the background and don't wait for it: while it runs, do what reads or runs but
does not edit the files under review: steps 4 to 7 (CI's checks in the clean checkout,
monitoring, words, invariants) and a draft of the report. Edits wait for the review (a fix
found meanwhile joins its fixes), so the reviewer never reads a tree that is changing. Only
runs the repo's test limits allow beside the review go at the same time: tell the reviewer
which ports, databases and suites the session will use while it runs, so it leaves them
alone. Until the review's result is in and handled, every reply says built, not done, and
what it waits on; nothing of the change is committed to the user's branch, pushed or merged,
unless the user says to ship it as it is (commits in a temp clone made for a review are
fine); and either way it is not called done. Any edit CI's clean checkout does not hold (a
review-led fix, or one a check led to) reruns CI's checks in a clean checkout holding the final
change, sized to the whole change as step 0 says, and the words, monitoring and invariants checks for what it
changed. When the result is in, a confirmed finding you list rather than fix that breaks an
invariant goes into its Known breaks (step 7).

Sort each finding by its worst case, never by the severity the reviewer gave it:

- **Real harm: fix it now.** Real (CONFIRMED, or PLAUSIBLE and you confirm it), and its
  scenario does real harm (money lost, wrongly charged or spent without a cap, lost or
  leaked data, a side effect done twice, sent wrong or sent without the yes it needs, a
  security hole, a legal breach, a crash, work left stuck: a job that never finishes, or a
  person who can't finish what they started), or it stops the change doing what it was for.
  Fix it with its own failing-first test (step 2), and run the breaker on that fix, again on
  each new real-harm fix, until one review finds no new real harm. From the second review on,
  real harm whose Who meets it is `unusual` waits instead: collect it, fix it in one batch
  once the item's other fixes are reviewed (each with its own failing-first test), and give
  the batch one review. Rare-path harm that review, or any later review of the same item,
  finds starts no new round: it goes first on the list (step 8) as real harm; nothing of the
  item ships until the user answers it, and while it stays unfixed the item is built, not
  done. Harm met in normal use (`everyone`, `feature`) is still fixed as
  it is found. Write each finding that waits in the batch, or for the user's answer, in the
  task list when it is found, and say after each review which harm waits, so a compacted
  context cannot lose it.
- **Smaller: list it.** Real, but none of the above: words wrong in some state, a button that
  shows when it does nothing, a clumsier path. Don't fix it, and don't ask the user about it
  during the work: put it on the item's list with its worst case and who meets it.
- **Disagree:** say why in the report, with file:line.
- **Older** (inside the task's scope, but the change neither caused it nor made it worse): on
  the list, marked as older than the change, whatever its harm; a real harm among them is
  named first.
- **Outside the task's scope** (the rules' "Stay in the task's scope"): not a finding. When
  it does real harm, one line in the report under "Outside this task" (and a Known breaks line
  when it breaks an invariant, step 7); otherwise left out. A problem the change caused or
  made worse is never outside, wherever it lives.

A fix that touches code another item in the same prompt uses gets its review on the combined
diff. Say after each review what it found and what is left ("item 1: review of the fix found
no new real harm; 3 on the list"), so it survives a compacted context.

The list goes to the user once, at the end (step 8), numbered, each with its worst case and
who meets it, with one question: which to fix. The fixes they pick are built together, with
the proof step 2 asks for (or the one the Jev judge picks, below), and get one review
together. That review's real harm is fixed as above; its smaller findings go on a new list
in that report, not fixed unasked.

**The Jev judge** (Claude Code plugin, when the user has set it up with `/first-pass:jev`;
`node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev status <repo>` says whether it is on for
this repo). Write the findings to a JSON file in the system temp folder, one object each:
`{"id": "3", "scenario": "<the inputs or state, then the wrong result>", "worst_case": "<money|data|twice|security|legal|crash|stuck|task|small>", "who": "<everyone|feature|unusual|nobody>"}`,
using the breaker's Worst case and Who meets it. Leave customers' data out of the scenario
(the script also blanks secrets, emails and phone numbers before it sends anything to
TypeSafe). Then `node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev ask harm <file> <repo>`,
where `<repo>` is the repo's own folder (never the temp clean checkout: the key is chosen by
it), prints a verdict for each:

- `fix now`: real harm (the review named it, or Jev found it): handle it as real harm above says
  (at once; in the batch when its Who meets it is `unusual` and a later review found it; or
  first on the list when the batch's review or a later one found it), unless it is older
  than the change, which also puts it first on the list. Jev can make a finding real harm; it never
  clears one the review named, and you may still treat any finding as real harm yourself,
  never the reverse.
- `list`: smaller; it goes on the list.
- `rule`: Jev was not used or was unsure (the reason is printed): sort it yourself, as above.
  A `jev ask` that fails or is stopped before it prints means `rule` for every finding.

In the files for the next two questions, a finding sorted as real harm (by the review, by Jev
or by you) carries that harm as its `worst_case` (Jev's `choice` when Jev found it), so the
script recommends fixing it now and gives its fix the full proof. For the list,
`node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev ask priority <file> <repo>` gives each
finding the answer to recommend (`fix now` or `leave listed`; `rule`: your own). For each fix
the user picks, add `"fix": "<what the fix changes, one line>"` and run
`node "${CLAUDE_SKILL_DIR}/../../scripts/cli.mjs" jev ask proof <file> <repo>`: `checks`
(format, lint, type and build checks and reading the changed text), `unit`, `real` (a test
against the real database or service) or `browser`; `rule` means step 2 as written. A
real-harm fix always gets step 2 as written. Delete the findings file when done.

## 4. CI's own checks, in the clean checkout

In the step 2 worktree with the whole change copied in, run exactly the commands CI runs
(format, lint, typecheck, build, unit tests, integration and end-to-end tests the change
touches; the whole integration suite when the change touches jobs, payments, publishing,
deletion or auth). Follow the project's rules for heavy runs.

A failure that also happens on the base without the change is pre-existing: name the test
and move on. A failure the change caused gets a fix; a fix that is more than small goes
back to step 3, reviewed like a fix for real harm, and the full checks run again. Then remove the worktree (`git -C <repo> worktree remove --force <path>`) and any leftovers,
including copied env files.

## 5. Monitoring

List what now reaches monitoring and at what level. Every error the change swallows is
reported at a level someone will see. For a bug fix, consider a tripwire: a report that
fires if the exact failure ever happens again.

## 6. Words

Search UI strings, emails and notifications, help, docs, and pricing and legal pages for
sentences about what changed. Each is confirmed true or changed. A sentence a review finds
untrue only in some state (after an unusual order of steps, a race or an error), and that is
not legal, pricing or privacy text, is a smaller finding: it goes on the item's list (step
3), not changed mid-work. Changes to legal, pricing
or public copy get their own line in the report.

## 7. Invariants

For each invariant in `INVARIANTS.md` the change touches: held, or broken (add it to Known
breaks). If the change fixes a known break, move its id out.

## 8. Report

In plain words. Leave out any line with nothing in it, except Public copy changed and Fresh
review.

```
<What changed, one plain line: what the user can now do or will notice>
Verified: <what was run and how much of it, said plainly> → <result>, one line each (the test that failed before and passes now, with pass and fail counts; CI's checks)
Fresh review: <what the second reviewer found: n fixed, n disputed, n on the list>
To pick: <real harm left for the user's answer first, then the smaller and older findings, numbered, each with its worst case and who meets it>
Outside this task: <real harm seen in passing outside the scope, one line each with file:line>
Not verified: <each thing, and why>
Not handled, because: <each, from the pre-mortem>
Not built: <each guess left out, one line each>
Public copy changed: <file, or "none">
Open: <follow-ups, one line each>
```

"Verified" only ever sits next to something run in this session and its result. The exact
command and file:line go in when the user will use them, when something failed, for each
disputed finding (step 3), and wherever a rule or skill asks for them. If any step above was
skipped, the change is not done: say "not done" and why, not "done with caveats".
