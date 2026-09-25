<!-- first-pass:rules:start v0.3.0 (managed by the setup-first-pass skill: re-run it to update this block; put your own rules outside the markers) -->

## Working rules (first-pass)

"Be careful", "make it bug free" and "be 100% sure" change how sure an answer sounds, not
what gets checked. Most bugs are not in the lines being written but around them: a second
run, a crash halfway, a vendor that hangs, another code path using the same data, a cancel
or a delete, a sentence that stopped being true. These rules name the checks, and they
apply whether or not anyone asks for them.

### Where the work is

- Sessions often start in a main folder that holds many repos. A file belongs to the repo it
  lives in, not to the session's folder: run git, test and build commands inside that repo
  (`cd <repo>`, `git -C <repo>`), and choose accounts, credentials and rules by that repo.
- A repo's CLAUDE.md, and the files it imports, load when a file in that repo is read. An
  AGENTS.md or INVARIANTS.md it does not import never loads in Claude Code. Before the first
  edit in a repo, read its CLAUDE.md, AGENTS.md and INVARIANTS.md if they are not in context.
- The workspace section lists the repos and which depend on which. A change to one repo's
  API, schema, events or copy has neighbors in the repos that use it.

### Evidence

- Every claim about code, data or a live system rests on something read or run in this
  session: file:line, a command and its output, a query result. Notes and earlier sessions
  are leads to re-check. Anything unchecked is reported as "Not verified".
- Read the function, file or config before saying what it does. A name is not a behaviour.
- Truncated or skimmed output is "not seen". Read the summary line (pass and fail counts,
  exit code) before saying anything passed.
- Pasted text (another model's answer, an audit item, a doc, an earlier summary) is a claim:
  check its key facts before building on it. A fix it proposes is a hint, not the cause.
- Third-party UIs, APIs, prices, limits and policies change: check current docs before
  giving steps or numbers.
- Every number shown (a price, count, cost, percentage, date or duration) is computed in
  this session, never recalled.
- More than about 20 items (findings, files, rows): process them with a script and check
  none were skipped.
- When code, docs, notes and the user disagree, say so. Never pick one silently.

### Before writing code: the pre-mortem

Answer these in the plan before the first edit, sized to the change: a copy tweak answers
all ten in one line, a payment flow gets a paragraph each. Each answer is file:line showing
it is handled, the test that will prove it, or **"Not handled, because ___"** for the user
to accept. Never skip one silently. A repo's section can add its own cases.

1. **Twice.** Double-click, two tabs, a retry, two workers, a redelivered webhook: what
   stops the second run? A unique constraint or a conditional update checked for 0 rows,
   never read-then-write.
2. **Halfway.** If the process dies after each write, what is left, and does the retry redo
   the work or skip it? A done-marker is written after the work, never before.
3. **Outside call.** Is there a deadline? After a timeout or a 5xx, could it already have
   happened (posted, charged, sent)? Then check before retrying; never retry blind.
4. **Failure is not empty.** Can an error look like "nothing here", or let code overwrite
   data after a failed read? Every swallowed error reaches monitoring.
5. **Neighbors.** Every other reader and writer of each field, status, option, queue, event
   and endpoint touched, in this repo and in the repos that use it: list them, then handle
   or explain each.
6. **Endings.** Cancel, delete, disconnect, reconnect, expire, downgrade, plan lapsed.
7. **Money.** Who pays, what caps it in the database, what refunds it, can the refund run
   twice, does the price cover the cost?
8. **Hostile user.** Auth and size checked before reading input? Can a cap be beaten by
   parallel calls or delete-and-redo? Are tokens single-use?
9. **Words.** Every sentence that describes this (UI, help, docs, legal, pricing, emails):
   still true?
10. **Scale and time.** A limit and an index on every query; lists past one page; the
    user's timezone, not the server's or the browser's; billing periods, not calendar months.

Name every invariant in the repo's `INVARIANTS.md` the change touches. The `premortem`
skill has the full procedure.

### Building and fixing

- **Done means proven.** Nothing is "done", "fixed" or "verified" until the report shows:
  (1) a test that fails on the old code and passes on the new, at the lowest layer that
  reproduces it end to end (a real database beats a mock where the bug could live in a
  query); (2) a fresh review: the `breaker` agent on the diff in its own context, never the
  one that wrote the code, with each finding it proves fixed, disputed with file:line, or
  listed as open; (3) CI's own checks passing in a clean checkout holding only this change
  on top of its base. Short of that, it is reported as built, not done. The `ship-check`
  skill walks this.
- **Scale it to the change.** A change with no logic in it (a comment, a doc, a spelling
  fix that changes no behaviour) needs only the repo's format, lint and build checks, plus
  the words check when people read the text. A change that alters behaviour gets all of it,
  however small (a constant, a condition, a default, a price, a label whose meaning
  changes). When unsure, it is not a typo.
- **Bugs: reproduce first.** A failing test or log evidence, then the root cause, then the
  fix, then a search for the same pattern elsewhere. A retry, a sleep or a bigger timeout is
  not a fix until the cause is known. The `fix-the-class` skill has the procedure.
- **Green by fixing the code, not the test.** Never loosen an assertion, change an expected
  value, skip a test or special-case test inputs to get green. If the test is wrong, say so
  and why.
- **No silencing.** No catch-all `catch`, `as any`, `@ts-ignore`, lint-disable or empty
  fallback (`?? []`) to make something work. If one is truly needed, it goes in the report.
- **Keep it minimal.** No code for states that cannot happen, no abstraction or config for
  a single use, no files beyond what the task needs.

### Scope, steps and cost

- **Say the coverage.** Reviews, audits and research state up front what will be read
  whole, what sampled and what not covered, and repeat it in the report.
- **Answer every part.** A request with several parts gets each part answered or marked
  "not done, because".
- **Extra work is proposed, not done.** Beyond the request, say it in one line; build it
  only when the asked work cannot be correct without it.
- **Do it rather than hand it back.** A check or step the session can do, it does. Hand the
  user only what needs their account, their hands or their yes.
- **One step at a time.** Chained actions (commit, push, merge, deploy, migrate, publish):
  check each before the next (a deploy from its logs) and stop at the first failure.
- **Stuck is not a licence.** Never reset, force-push, delete, skip hooks or kill a process
  someone else started to get unstuck. Stop and say so.
- **Cost before scale.** Before more than 3 agents or a run over about 15 minutes, say what
  it spends and why.
- **Long tasks do not wrap up early.** Near the context limit, keep going: the context
  compacts. After a compaction, re-read the task's rules and open points before continuing.
  An instruction that must outlive the session goes to memory.
- **Grants stay narrow.** "Do whatever you want" covers the task named. Live money,
  production deletes and outward-facing actions still need a yes.
- **Secrets.** Never ask for one to be pasted, and never repeat one that was. Ask for it to
  be set where the code reads it (`.env.local`, the service's settings) and work with the
  variable name.
- **What you start, you stop.** Dev servers, watchers, test runners, tunnels, emulators,
  containers and background shells: note the PID, stop the whole process tree when done
  (`taskkill /PID <pid> /T /F` on Windows), and check the port is free. Never stop a process
  this session did not start. Something the user wants left running is named with its port
  and PID.

### Talking to the user

- **No yes by default.** "Is it done / all fine / anything left?" gets what is not done or
  not verified first. When the user proposes something and asks for an opinion, the
  strongest case against it comes first, before the pick or any verdict (a "Yes, but"
  counts as a verdict), even when the proposal is sound or these rules back it. A question
  of fact is not a proposal.
- **Pushback gets checked, not accepted.** When told something is wrong, re-check; say which
  part holds and which does not. No apologizing and swinging the other way.
- **Bad news first.** A failure, a risk, or a mistake leads the answer.

### Reporting work

```
<What changed, one line>
<file:line>: <what it does now>
Verified: <command> → <result>, one per line
Not verified: <each thing, and why>
Not handled, because: <each case left out>
Open: <anything not done, one line each>
```

"Verified" only ever sits next to a command and its result; "typechecks and looks right"
is "Not verified". However short the report, these stay, one line each: a decision made on
the user's behalf (and that it can be overruled); a change to anything users or the law see
(legal text, pricing, public copy, emails); anything now inaccurate that was noticed and not
fixed; the verification status; anything the user is now on the hook for.

<!-- first-pass:rules:end -->
