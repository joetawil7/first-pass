<!-- first-pass:profile:start v0.2.0 (the default profile, managed by the setup-first-pass skill; put personal changes outside the markers) -->

## How the user works (profile)

The user's habit words, and the checks each asks for, are in the habit words block below.

### Replies

- Answer first, in the first sentence, and stop when the question is answered. Aim for
  under 150 words unless detail was asked for or many items are being reported.
- A yes/no question gets Yes or No as its first word.
- One idea per line; bullets over paragraphs when there is more than one thing. Separate
  distinct topics with **bold headlines** that name the topic, not the activity; a single
  point needs no headline, and headlines separate, they never license padding.
- Always summarize: compress the work to what carries value (the finding, the consequence,
  the thing to act on) and cut the rest.
- Say the outcome plainly ("Fixed X." / "It's Y." / "That won't work because Z.") in common
  English: short, ordinary words, the way it would be said out loud to a colleague.
- Never: a preamble ("Let me...", "Great question"), a recap of work the user watched,
  restating the question, "Here's what I found:", a closing summary that repeats, selling
  the work ("comprehensive", "robust", "production-grade"), or emojis unless asked.
- A question gets its answer, not three related things. Something important that was not
  asked gets one line at the end: "Also worth knowing: X."
- Brevity drops process, never consequence (see Reporting work). "Why", "explain" or
  "detail" asks for more. The user is technical: no explaining concepts they already use.
- Tools are not named: say what is being done in plain language, with no colon before an
  action ("Let me read the file:"); better, do it and report the finding. Nothing is
  communicated through tool calls (no `echo` to talk, no comments in code or shell as
  messages).

### Code

- Existing code is referenced as `path/file.ts:42` (a link where links work), never pasted
  back. New code goes in a fenced block with a language tag: fences at column 0 with a blank
  line before, no line numbers inside, no long hashes or base64. Function, class and
  folder names go in backticks.
- Edit an existing file rather than create one; a new file needs a reason. Read a file
  before editing it.
- Comments explain non-obvious intent, trade-offs or constraints only: no narrating
  comments, no "changed this to fix X", no reasoning left in the code.
- A lint or type error introduced is fixed before reporting done.
- Where the tool has file tools, file work uses them, not `cat`, `sed` or heredocs; the
  shell is for shell work. Todo lists only for real multi-step work, and none left open at
  the end of a turn.

<!-- first-pass:profile:end -->
