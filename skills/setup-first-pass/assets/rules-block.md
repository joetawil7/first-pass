<!-- first-pass:rules:start v0.1.0 (managed by the setup-first-pass skill: re-run it to update this block; edit the project block below instead) -->

## Shipping rules (first-pass)

"Be careful" and "make it bug free" change nothing; named checks do. Most bugs are not in
the lines being written but around them: a second run, a crash halfway, a vendor that
hangs, another code path using the same data, a cancel or a delete, a sentence that stopped
being true.

### Before writing code: the pre-mortem

Answer these in the plan before the first edit, sized to the change: a copy tweak can
answer all ten in one line, a payment flow gets a paragraph each. Each answer is one of:
file:line showing it is handled, the test that will prove it, or
**"Not handled, because ___"** for the owner to accept. Never skip one silently.

1. **Twice.** Double-click, two tabs, a retry, two workers, a redelivered webhook: what
   stops the second run? A unique constraint or a conditional update checked for 0 rows,
   never read-then-write.
2. **Halfway.** If the process dies after each write, what is left, and does the retry
   redo the work or skip it? A done-marker is written after the work, never before.
3. **Outside call.** Is there a deadline? After a timeout or a 5xx, could it already have
   happened (posted, charged, sent)? Then check before retrying; never retry blind.
4. **Failure is not empty.** Can any error look like "nothing here", or let code overwrite
   data after a failed read? Every swallowed error reaches monitoring.
5. **Neighbors.** Every other reader and writer of each field, status, option, queue,
   event and endpoint you touch: list them, then handle or explain each.
6. **Endings.** Cancel, delete, disconnect, reconnect, expire, downgrade, plan lapsed.
7. **Money.** Who pays, what caps it in the database, what refunds it, can the refund run
   twice, does the price cover the cost?
8. **Hostile user.** Auth and size checked before reading input? Can a cap be beaten by
   parallel calls or delete-and-redo? Are tokens single-use?
9. **Words.** Every sentence that describes this (UI, help, docs, legal, pricing, emails):
   still true?
10. **Scale and time.** A limit and an index on every query; lists past one page; the
    user's timezone, not the server's or the browser's; billing periods, not calendar months.

Name every invariant in `INVARIANTS.md` the change touches. The `premortem` skill has the
full procedure.

### Done means evidence

Nothing is "done", "fixed" or "verified" until all of this ran and the report shows it:

1. **A test that fails on the old code** and passes on the new, at the lowest layer that
   reproduces the behaviour end to end (a real database beats a mock where the bug could
   live in a query).
2. **A fresh review.** The `breaker` agent reviewed the diff in its own context, never the
   one that wrote the code. Each finding it proves is fixed, disputed with file:line, or
   listed as open.
3. **CI's own checks** passed in a clean checkout holding only this change on top of its
   base.
4. **The report** says `Verified: <command> → <result>` for each check, and lists
   `Not verified` and `Not handled, because` items. "Verified" only ever sits next to a
   command and its output; "typechecks and looks right" is "Not verified".

The `ship-check` skill walks this list. Slower and complete beats fast and looped.

### When a bug is found

Fix the instance and the class: name the pre-mortem question it failed, search the codebase
for the same pattern, fix or record each hit, and add the rule, invariant, helper or check
that stops it coming back. A fix that guards only the spot where it was found invites the
same bug in the next feature. The `fix-the-class` skill has the procedure.

<!-- first-pass:rules:end -->
