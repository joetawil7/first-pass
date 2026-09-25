// sharpen's gate. In a turn the user started with `/first-pass:sharpen <prompt>` (or
// `/sharpen <prompt>`), a tool that changes something, acts outside the machine or loads
// another skill is denied until a reply in that turn has shown the rewrite, and a turn that
// ends without showing it is sent back once. The skill says the same thing; with the
// instruction alone the rewrite was skipped in 7 of 11 test runs, most often once another
// skill (premortem, fix-the-class) loaded.
import fs from 'node:fs';
import { readRecord, writeRecord } from './state.mjs';

// Only a command with a prompt after it: with none, the skill asks for one and stops.
export const SHARPEN_PROMPT = /^\s*\/(?:first-pass:)?sharpen\s+\S/;
// The tools hooks/hooks.json sends to PreToolUse by name, plus every MCP tool (its own
// matcher group): the ones that change files, run commands, start or resume other agents,
// publish, or schedule work. Read, Grep and Glob stay free, so the rewrite can be checked
// against the code.
export const GATED_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Skill',
  'Agent', 'Task', 'SendMessage', 'Workflow', 'RunWorkflow', 'Artifact', 'RemoteTrigger', 'CronCreate',
]);
export const isGated = (tool) => GATED_TOOLS.has(tool) || String(tool).startsWith('mcp__');
// The gate gives up after this many replies from the model since its first denial, so
// several calls in one message cost one reply, not the whole allowance.
export const MAX_REPLIES = 3;
// A backstop, in denied calls, for a transcript that is missing or not being written, where
// replies cannot be counted. With up to 10 gated calls per reply it is never reached before
// MAX_REPLIES; past that it can end the hold a reply early.
export const MAX_CALLS = 30;
// The line the skill puts before its questions when step 4 stops to ask: the turn then ends
// there, with no send-back.
const ASKING = /\bBefore I start\b/i;
const SHOWN = /\bSharpened\b/;
const RECORD = 'sharpen';

// UserPromptSubmit: a sharpen prompt arms the gate for that prompt; any other prompt ends it.
export function armSharpen(input) {
  if (!SHARPEN_PROMPT.test(input.prompt ?? '')) {
    if (readRecord(input.session_id, RECORD)) writeRecord(input.session_id, RECORD, null);
    return;
  }
  writeRecord(input.session_id, RECORD, { prompt: input.prompt_id ?? null, offset: transcriptSize(input), denials: 0 });
}

function transcriptSize(input) {
  if (!input.transcript_path) return 0;
  try {
    return fs.statSync(input.transcript_path).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

// What the main agent wrote since the prompt: whether any reply text shows the rewrite, and
// how many replies there were. Only the part of the transcript written after the prompt is
// read, so a long session costs nothing extra.
export function scanTranscript(transcriptPath, offset) {
  const result = { shown: false, replies: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;
  const size = fs.statSync(transcriptPath).size;
  const start = offset <= size ? offset : 0;
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const replies = new Set();
  const lines = buffer.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      // The last line can be mid-write.
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (row.type !== 'assistant' || row.isSidechain || !Array.isArray(row.message?.content)) return;
    // One reply is saved as one row per content block, all with the same message id.
    replies.add(row.message.id ?? row.uuid ?? `line ${index}`);
    if (row.message.content.some((part) => part?.type === 'text' && SHOWN.test(part.text ?? ''))) result.shown = true;
  });
  result.replies = replies.size;
  return result;
}

// This prompt's record, or null. Subagents are never gated: the Agent call that starts one
// already was.
function current(input) {
  if (input.agent_id) return null;
  const record = readRecord(input.session_id, RECORD);
  if (!record || record.prompt !== (input.prompt_id ?? null)) return null;
  return record;
}

// The skill ends a message with the rewrite and no tool call; Stop then sees it in
// `last_assistant_message` and lets the work go on. A rewrite written next to a tool call
// is found in the transcript instead, which Claude Code saves only after that call's hooks
// run, so the first call is denied and the retry goes through.
export function sharpenGate(input) {
  if (!isGated(input.tool_name)) return null;
  const record = current(input);
  if (!record || record.gaveUp || record.working) return null;
  const seen = record.shown ? { shown: true, replies: 0 } : scanTranscript(input.transcript_path, record.offset);
  if (seen.shown) {
    writeRecord(input.session_id, RECORD, { ...record, shown: true, working: true });
    return null;
  }
  const firstDeniedAt = record.firstDeniedAt ?? seen.replies;
  if (seen.replies - firstDeniedAt >= MAX_REPLIES || record.denials >= MAX_CALLS) {
    writeRecord(input.session_id, RECORD, { ...record, gaveUp: true });
    return { name: 'first-pass sharpen', own: true, json: { systemMessage: "first-pass: sharpen's rewrite was not shown before the work started, so the prompt is being worked on as written." } };
  }
  writeRecord(input.session_id, RECORD, { ...record, denials: record.denials + 1, firstDeniedAt });
  return {
    name: 'first-pass sharpen',
    own: true,
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'first-pass sharpen: this turn started with the sharpen command, and no saved reply text shows the rewrite yet. ' +
          'Write the **Sharpened** block (or the "Sharpened: already clear" line) as reply text and end the message there, with no tool call: ' +
          'first-pass then lets the work continue. A rewrite only in thinking does not count, because the user cannot see it. ' +
          'Read, Grep and Glob are not held back.',
      },
    },
  };
}

// The Stop input the other Stop checks and repo hooks should see. Sending the model back
// (either send-back below) sets Claude Code's `stop_hook_active` for the rest of the turn,
// so the Stop that ends the work would look like a repeat and the done check and repo Stop
// hooks would skip it. The first Stop after sharpen's own send-back is shown to them as a
// first Stop. Hooks Claude Code runs itself (a repo's own, when the session starts inside
// it; other plugins') still see the flag: this can only change first-pass's own input.
export function sharpenStopView(input) {
  if (!input.stop_hook_active) return input;
  const record = current(input);
  if (!record?.sentBack || record.resumed) return input;
  writeRecord(input.session_id, RECORD, { ...record, resumed: true });
  return { ...input, stop_hook_active: false };
}

export function sharpenStop(input) {
  const record = current(input);
  if (!record || record.working || record.stopSent) return null;
  const last = input.last_assistant_message ?? '';
  const showsNow = SHOWN.test(last) || record.shown || scanTranscript(input.transcript_path, record.offset).shown;
  if (showsNow && record.gaveUp) return null;
  if (showsNow && ASKING.test(last)) {
    writeRecord(input.session_id, RECORD, { ...record, shown: true, stopSent: true });
    return null;
  }
  if (showsNow) {
    writeRecord(input.session_id, RECORD, { ...record, shown: true, stopSent: true, sentBack: true });
    return {
      name: 'first-pass sharpen',
      own: true,
      json: {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext:
            'first-pass sharpen: the rewrite is shown. Now do the work from it (step 6 of the skill). If step 4 stopped to ask the user, ' +
            'or the reply above already answers every ask, reply with one short line saying so, and do not repeat the rewrite.',
        },
      },
    };
  }
  writeRecord(input.session_id, RECORD, { ...record, stopSent: true, sentBack: true });
  return {
    name: 'first-pass sharpen',
    own: true,
    json: {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          'first-pass sharpen: this turn was started with the sharpen command and no reply showed the rewrite. ' +
          'Show the **Sharpened** block now, and say where the work above followed it and where it did not.',
      },
    },
  };
}
