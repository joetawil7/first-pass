---
name: sharpen
description: Rewrites the prompt typed after the command before any work starts, then works from the rewrite. Splits a mixed-up message into a numbered list of asks, turns words like "be 100% sure", "cover all cases" or "don't break anything" into the checks they stand for, keeps every name, path, number and quote exactly, and stops to ask only where it would have to guess. Runs only when the user types it.
disable-model-invocation: true
argument-hint: <your prompt>
---

# sharpen

The prompt to rewrite:

<prompt>
$ARGUMENTS
</prompt>

If the prompt block above is empty or still shows a placeholder, the prompt is the text the
user sent with this command. If there is none, ask for it and stop.

**The rewrite (step 5) is shown before any other skill, edit or command that changes
anything.** The user typed this command to see how their prompt was read; work that starts
without showing it has skipped the skill. It is not a preamble or a restatement of the
question, so reply rules against those do not apply to it. It goes in the reply text, never
only in thinking, which the user cannot see. Other skills the work calls for (`premortem`,
`fix-the-class`, `ship-check`) are loaded only after it.

**When this runs as `/first-pass:sharpen` (the Claude Code plugin), the rewrite is a
message of its own: write it, then end the message with no tool call.** The plugin's hooks
hold back edits, shell commands, subagents, MCP tools, publishing, scheduling and other
skills until reply text
starting with the word **Sharpened** has been shown, then tell you to go on with the work.
Read, Grep and Glob are never held back. Anywhere else (Cursor,
or the skill installed without the plugin), go straight on to the work in the same reply.

A prompt written in a hurry mixes three asks in one sentence, says "be 100% sure" where it
means "show me the proof", and leaves the agent to guess which part is a question. This
skill rewrites it into what the user meant, shows the rewrite, then does the work from it.
The user's intent is the source: the rewrite may reorder, split and name things, never add
or change what is asked.

## 1. Read it for what the user wants

- **Goal:** what the user is after, in one line, in their words. Keep their "why" if they
  gave one.
- **Asks:** every separate thing to do or answer. "Check X, fix Y and tell me Z" is three.
  Mark each as a question (answer it, build nothing), a change (build it), a check (look
  and report, change nothing) or a call the user must make. "I want X, can we do that?" is
  a change; "can we do X?" alone is a question. When it could be either, say which reading
  you took.
- **Facts:** every name, path, file, URL, number, date, error message, quoted text and code,
  copied exactly. Never paraphrase one or correct its spelling.
- **Limits:** what not to touch, which repo or account, what needs a yes, deadlines.
- **Context:** what the user tried, saw or already knows that the work needs.
- **Drop:** repetition, filler, and emphasis (capitals, "!!!", "IMPORTANT", "please
  please"). Nothing is lost: each point is said once, and the habit words become checks.

## 2. Turn habit words into checks

A word that asks for certainty or completeness without naming a check becomes the check it
stands for. Use the user's own habit words block (`first-pass:words`) when it is loaded;
otherwise this list:

| They wrote | It becomes |
| --- | --- |
| "be 100% sure", "confident", "don't assume" | Evidence: each claim cites a command and its output or a file:line read now; the rest is listed as "Not verified" |
| "cover all cases", "bug free", "doesn't break anything" | The pre-mortem, with every other reader and writer of the data touched, and the test that proves each case |
| "full", "deep", "comprehensive", "everything" | Say the coverage: what is read whole, what sampled, what not covered |
| "carefully", "correctly", "properly", "perfect", "take your time" | Done means proven: a test that fails first, the breaker's review, CI's checks in a clean checkout |
| "all fine, right?", "is it done?", "anything left?", "that's best?" | What is not done or not verified comes first; for "best?", the strongest case against before the pick |
| "are you sure?", "this doesn't make sense" | Re-check the claim at its source; say which part holds, which does not, and why |
| "fix it once and for all" | Reproduce it first, then fix the class (`fix-the-class`) |
| "make it secure", "no hacking possible" | The hostile-user question as concrete attacks, each with a test |
| "do whatever you want", "take control" | The task named only; money, production deletes and anything outward-facing still need a yes |

- Each check is named once, however many words the user stacked for it.
- Size it to the ask: a question needs Evidence, not a pre-mortem; a copy change needs the
  words check; a change to payments, data or auth gets the pre-mortem and Done means proven.

## 3. What the rewrite never does

- **Add scope.** No asks, features, files or refactors the user did not ask for. An idea
  worth having goes in one line under "Not asked".
- **Change strength.** "Look at" never becomes "fix", and "fix" never becomes "look at".
- **Fill a gap with a guess dressed as a fact.** "The login bug" with no file named stays
  "find the login bug" as the first step, not a file you picked.
- **Repeat a secret.** A key, token, password or connection string in the prompt becomes
  `<secret left out>` in the rewrite, and one line tells the user it is now in this chat's
  history and should be rotated and set where the code reads it (`.env.local`, the
  service's settings). The work uses the variable name.
- **Start the work inside the rewrite.**

## 4. Guesses

List each place you had to choose a reading, and the reading you took. Then:

- **Stop and ask** when a guess changes what gets built or touched: two readings lead to
  different work, the asks conflict, the target cannot be found, or it touches money,
  deletes, production, other people or anything outward-facing. Ask short questions, each
  with your guess as the default, last in the message under the line **Before I start:**
  (the plugin's hooks see it and end the turn there), and start nothing until the user
  answers.
- **Otherwise go on**, with the guesses listed so the user can stop you on a wrong one.

## 5. Show the rewrite

Reading files (Read, Grep, Glob) to settle a guess may come first; nothing else does. It
is always shown:

```
**Sharpened**

Goal: <one line>

1. <ask> (<question | change | check | your call>)
   Done when: <the proof it needs, for a change or a check>
2. <ask> ...

Context: <what the user gave, facts exact>
Limits: <repo, account, what not to touch, what needs a yes>
Checks: <each check the habit words asked for, once>
Guesses: <each reading taken>
Not asked: <one line, only if there is one>
```

Leave out any line with nothing in it. Under the block, one line on what changed from the
original ("split into 3 asks; 'be 100% sure' and 'don't assume' became Evidence; a pasted
key left out"), so the user can see nothing was lost.

A prompt that is already clear gets the line **Sharpened: already clear, working from it as
written.** instead of the block, still first. A one-ask prompt gets a short block, not every
heading.

## 6. Work from it

Once the rewrite is shown, and unless step 4 stopped, the rewrite is the task. Work the asks
in order, dependencies first. The report answers each ask by its number, and shows each
check from the Checks line
with its evidence (the pre-mortem's answers, the test that failed first, the breaker's
findings), or marks it "not done, because". Where the rewrite and the original prompt
disagree, the original wins: say so and follow it.
