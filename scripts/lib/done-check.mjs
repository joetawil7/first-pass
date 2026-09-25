// The done check: a turn that changed code and ends by calling the work done, fixed or
// verified, with no `Verified: <command> → <result>` line, is sent back once. The rules
// say the same thing; this makes it a check instead of a hope.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
// Words that claim the work is finished. "Works", "working" and "ready" also describe how
// code behaves ("here is how the retry works"), so they are left out.
const CLAIM = /\b(done|fixed|verified|completed|shipped|resolved)\b/gi;
const NEGATED = /\b(not|never|no|cannot|nothing\s+(?:is|was|has\s+been)|\w+n['’]t)\s+(yet\s+|been\s+|fully\s+)?$/i;
const EVIDENCE = /^[\s>*_-]*(\*\*)?Verified(\*\*)?\s*:/m;
// A report that lists what it did not verify is honest about its state, not a done claim.
const HONEST = /^[\s>*_-]*(\*\*)?Not verified(\*\*)?\s*:/im;

export function claimWord(message) {
  for (const match of message.matchAll(CLAIM)) {
    const before = message.slice(Math.max(0, match.index - 16), match.index);
    if (!NEGATED.test(before)) return match[0];
  }
  return null;
}

export function doneCheck(input, edits) {
  if (input.stop_hook_active || input.agent_id || !input.prompt_id) return null;
  const message = input.last_assistant_message ?? '';
  if (EVIDENCE.test(message) || HONEST.test(message)) return null;
  const code = edits.filter((edit) => edit.prompt === input.prompt_id && !DOC_FILE.test(edit.file));
  if (!code.length) return null;
  const word = claimWord(message);
  if (!word) return null;

  const files = [...new Set(code.map((edit) => edit.rel))];
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '');
  return {
    name: 'first-pass done check',
    own: true,
    json: {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          `first-pass done check: this turn changed ${files.length} code file(s) (${shown}) and the reply calls the work "${word}" ` +
          'with no `Verified: <command> → <result>` line. Under the working rules a change counts as done only with that evidence ' +
          '(the ship-check skill walks it); without it, the reply says what was built and lists what is not verified.',
      },
    },
  };
}
