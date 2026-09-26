#!/usr/bin/env node
// first-pass hooks. Claude Code runs this once per event (see hooks/hooks.json) with the
// event's JSON on stdin; it prints at most one JSON reply.
//   SessionStart      the drift check, plus approved session hooks
//   UserPromptSubmit  arms or ends sharpen's gate, then approved session hooks
//   PreToolUse        sharpen's gate, then approved hooks for the tool's repo
//   PostToolUse       notes which file changed, then approved hooks for its repo
//   Stop              approved hooks for each repo edited since their last run, the
//                     done check and sharpen's check
// With no `.first-pass/workspace.json` above the session there are no approved hooks:
// the done check and the drift check still run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook, selectRuns, toolTarget } from './lib/bridge.mjs';
import { doneCheck } from './lib/done-check.mjs';
import { drift } from './lib/drift.mjs';
import { merge } from './lib/merge.mjs';
import { gitRoot, pathKey, relative } from './lib/paths.mjs';
import { armSharpen, sharpenGate, sharpenStop, sharpenStopView } from './lib/sharpen-gate.mjs';
import { appendEdit, firstTime, readEdits, readOffset, removeOldSessions, writeOffset } from './lib/state.mjs';
import { findWorkspace, repoOf } from './lib/workspace.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// hooks/hooks.json sends these to PreToolUse for sharpen's gate only; repo hooks never saw
// them before the gate existed, so they still do not.
const GATE_ONLY_TOOLS = new Set(['Skill', 'Agent', 'Task', 'SendMessage', 'Workflow', 'RunWorkflow', 'Artifact', 'RemoteTrigger', 'CronCreate']);
const gateOnly = (tool) => GATE_ONLY_TOOLS.has(tool) || String(tool).startsWith('mcp__');
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pluginVersion() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

function recordEdit(input, ws) {
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const file = toolTarget(input);
  if (!file) return;
  const repo = ws ? repoOf(ws, file) : null;
  const root = gitRoot(file, repo?.abs);
  if (!root) return;
  appendEdit(input.session_id, {
    prompt: input.prompt_id ?? null,
    tool: input.tool_name,
    file,
    rel: relative(ws?.root ?? path.dirname(root), file),
    repo: repo?.name ?? null,
    root,
  });
}

// For a Stop hook: the repos it covers that this session edited since its last run.
function editedSince(sessionId, edits) {
  return (hook) => {
    const out = new Map();
    for (const edit of edits.slice(readOffset(sessionId, hook.id))) {
      if (edit.repo) out.set(`${edit.repo}\0${pathKey(edit.root)}`, { repo: edit.repo, root: edit.root });
    }
    return [...out.values()];
  };
}

// A paused hook is not run. Its notice reaches the user and, where the event takes context,
// Claude too: in a session nobody is watching, only Claude would see it.
function pausedNotice(event, outcome) {
  const text = `first-pass: the ${outcome.name} hook is paused because ${outcome.paused}. setup-first-pass can approve it again.`;
  const json = { systemMessage: text };
  if (CONTEXT_EVENTS.has(event)) json.hookSpecificOutput = { hookEventName: event, additionalContext: text };
  return { name: outcome.name, own: true, json };
}

// sharpen's gate is a nudge: if it fails, the user is told and everything else still runs,
// repo hooks included, instead of the whole hook failing with it.
function sharpenFailed(error) {
  return { name: 'first-pass sharpen', own: true, json: { systemMessage: `first-pass: sharpen's gate failed and was skipped for this step (${error.message}).` } };
}

function sharpenStep(step, input) {
  try {
    return step(input) ?? null;
  } catch (error) {
    return sharpenFailed(error);
  }
}

async function main() {
  const event = process.argv[2];
  const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = [];
  // At Stop, what the done check and repo hooks see (see sharpenStopView).
  let input = raw;
  if (event === 'Stop') {
    try {
      input = sharpenStopView(raw);
    } catch (error) {
      results.push(sharpenFailed(error));
    }
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const ws = findWorkspace(projectDir);
  // A session started inside a listed repo gets that repo's own hooks from Claude Code.
  const startRepo = ws ? repoOf(ws, projectDir) : null;
  const edits = event === 'Stop' ? readEdits(input.session_id) : [];

  if (event === 'SessionStart') {
    removeOldSessions();
    const lines = drift(ws, input, pluginVersion());
    if (lines.length) results.push({ name: 'first-pass drift check', own: true, json: { hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } } });
  }
  const sharpenSteps = { UserPromptSubmit: armSharpen, PreToolUse: sharpenGate, Stop: sharpenStop };
  if (event === 'PostToolUse') recordEdit(input, ws);
  if (event === 'Stop') {
    // Once per prompt: sharpen's view can show a later Stop in the same turn as a first one.
    const done = doneCheck(input, edits);
    if (done && firstTime(input.session_id, `done-${input.prompt_id}`)) results.push(done);
  }
  if (sharpenSteps[event]) {
    const sharpen = sharpenStep(sharpenSteps[event], input);
    if (sharpen) results.push(sharpen);
  }

  if (ws && !(event === 'PreToolUse' && gateOnly(input.tool_name))) {
    const runs = selectRuns(event, input, ws, editedSince(input.session_id, edits), startRepo);
    // Moved on before the hooks run, so a hook that hangs is not re-run on every later Stop.
    if (event === 'Stop') {
      for (const hook of ws.hooks) if (hook.scope === 'files' && Object.hasOwn(hook.events, 'Stop')) writeOffset(input.session_id, hook.id, edits.length);
    }
    const outcomes = await Promise.all(runs.map((run) => runHook(run, input, ws, event)));
    for (const outcome of outcomes) {
      if (!outcome.paused) results.push(outcome);
      else if (firstTime(input.session_id, `paused-${outcome.name}`)) results.push(pausedNotice(event, outcome));
    }
  }

  const reply = merge(event, results);
  if (reply) process.stdout.write(JSON.stringify(reply));
}

await main();
