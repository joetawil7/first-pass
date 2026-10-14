---
name: quick
description: Quick mode for the rest of the session. Instead of CI's full checks, a change runs only the checks it can affect (format, lint, types and build, its own tests, and every unit, integration, flow and browser test that reaches the code it touched), and the rest of the suite is left for a full run such as a pull request's CI. Runs only when the user types it, and `/first-pass:quick off` turns it off.
disable-model-invocation: true
argument-hint: <nothing to turn it on, or "off">
---

# quick

<args>
$ARGUMENTS
</args>

If the block above says `off`, or the user's message with this command does, quick mode is
off from now on: write "Checks: full" in the task list, and every change runs CI's full checks
as the rules say, a change already built included, before it is called done. Otherwise quick
mode is on, for the rest of this session, until the user types `/first-pass:quick off`. Asking
for CI's whole suite on one change runs it for that change and leaves the mode on; words like
"check everything", "cover all cases" or "full review" do not: they ask for full checks inside
the task's scope, which the chosen checks are. Only this typed command turns it on: "be quick",
"hurry" or "fast" in a prompt does not.

Quick mode changes which tests run here, nothing else: committing, pushing, pull requests,
merging and deploying stay as the rules say, each only when the user asks.

With quick mode on, wherever the rules, `ship-check` and `review`'s fixes (its step 8) ask for
CI's checks (in the clean checkout while the reviews run, and once more on the final change), the
checks the change can affect run instead, in the same clean checkout, within the same machine
limits, and under the same yes rules for runs that reach real people:

- the format, lint, type and build checks of every package the change touches;
- every test the change adds or changes, and the tests of every file it changes;
- every unit, integration, flow and end-to-end (browser) test file that reaches the changed
  code, directly or through its callers: the feature's own flow, and every other feature that
  reads or writes the same data or calls the same code (the pre-mortem's neighbors);
- a part it reaches through shared code runs whole when the change alters what that other
  code sees (a shared package's exports, a migration, a config value, a route's or event's
  shape);
- when the change touches jobs, payments, publishing, deletion or auth, the whole integration
  suite, as `ship-check` step 4 asks;

Find them in two steps: first follow the callers of each changed module, function, route, event
and table, caller by caller, until each path reaches something a test can drive (a route, a
job, an event, a command or a screen); then search the tests for the change, those callers and
those entry points. Where the test runner lists the tests related to changed files (Jest's
`--findRelatedTests`, Vitest's `related`), add its list too. Write the list in the plan. Run the
chosen files with the commands CI uses for their suites, with the servers and databases those
suites need. In a repo with a parts recipe, they run through the runner (`ship-check` step 4):
each part whose steps take a test list (`parts <repo> check` says `takes --tests`) gets its
chosen files with `--tests <part>=<file>,<file>`, the other chosen parts run whole by name, and
nothing runs by hand outside it. A chosen file the runner refuses (a path a test runner would
read as a pattern, or one outside the folder the part's tests run in) means that part runs
whole, never that the file is left out. After a run, check that each chosen file shows in the
test runner's own result lines in that part's log, named from the folder the runner ran in and
with either slash (Jest's PASS and FAIL lines, Playwright's lines for that file, the names of
node --test's tests from it), never in the command line pnpm or npm repeats above them: one that
does not, did not run. A run that selects no tests is not a pass: fix the selection, or run that part
whole. When unsure whether a test reaches the change, it runs. Everything else, test files that
reach nothing the change touched, is not run here.

Nothing else changes: the test that fails first, the fresh review, looking at the UI running,
and the words, monitoring and invariants checks all run as the rules say. A later edit reruns
the checks it can affect, as always, and once the last edit is in, the chosen checks run once
more on the final change unless each of them already ran after it.

Once the chosen checks pass (failures the base has too named) and every other step is done, the
change is done. The report says "Full checks on the final change: not run (quick mode)" with what
ran instead, so the user knows the rest of the suite is still to run, on a pull request's CI or
when they ask for it.

Write "Checks: quick" in the plan, and in the task list as an item kept open while the mode is
on, so it survives a compacted context; after a compaction, a task list without it means the
full checks.
