---
name: hulk
description: Lifts the task's scope for one task. The session, its reviews and fix-the-class then look across the whole codebase and every repo that shares its code, data or vendors, and every problem found anywhere is handled by the usual rules. Runs only when the user types it.
disable-model-invocation: true
argument-hint: <the task, or nothing for the current one>
---

# hulk

The task:

<task>
$ARGUMENTS
</task>

If the task block above is empty or still shows a placeholder, the task is the text the user
sent with this command, or, with none, the task the session is working on now.

The user typed this to lift the rules' "Stay in the task's scope" for this one task. Until
it is done:

- **The scope is the whole codebase**: the repo, and in a main folder every repo the
  workspace section says shares its code, data or vendors. Reads, searches, the pre-mortem's
  neighbors, `fix-the-class`'s search and the reviews go wherever the problem leads.
- **Problems found anywhere are findings**, handled as "Done means proven" and `ship-check`
  say: real harm the change caused or made worse is handled as they say (fixed at once,
  fixed in their one batch when only a rare path meets it, or first on the end list when that
  batch's review or a later one finds it), the rest goes on the one list at the end, older
  ones marked older. Nothing is marked "outside this task".
- **A review of a pull request or a branch** with the scope lifted is
  `/first-pass:review hulk <what to review>`.
- **Write it down**: "Scope: lifted (hulk)" in the plan, the pre-mortem's Scope line and the
  task list, so it survives a compacted context, and tell every reviewer the scope is lifted;
  a review already running is started again with the scope lifted.
- **Everything else in the rules still holds**: a yes before money, production or anything
  outward-facing; "Cost before scale" before more than 3 agents or a long run; one step at a
  time.

The next task the user gives gets its own scope again, unless they type this again.
