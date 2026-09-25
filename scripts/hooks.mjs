#!/usr/bin/env node
// first-pass hooks. Claude Code runs this once per event (see hooks/hooks.json) with the
// event's JSON on stdin; it prints at most one JSON reply.
//   SessionStart      the drift check, plus approved session hooks
//   UserPromptSubmit  approved session hooks
//   PreToolUse        approved hooks for the tool's repo
//   PostToolUse       notes which file changed, then approved hooks for its repo
//   Stop              approved hooks for each repo edited since their last run, and the
//                     done check
// With no `.first-pass/workspace.json` above the session there are no approved hooks:
// the done check and the drift check still run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook, selectRuns, toolTarget } from './lib/bridge.mjs';
import { doneCheck } from './lib/done-check.mjs';
import { drift } from './lib/drift.mjs';
import { merge } from './lib/merge.mjs';
import { gitRoot, key, relative } from './lib/paths.mjs';
import { appendEdit, firstTime, readEdits, readOffset, removeOldSessions, writeOffset } from './lib/state.mjs';
import { findWorkspace, repoOf } from './lib/workspace.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
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
      if (edit.repo) out.set(`${edit.repo}\0${key(edit.root)}`, { repo: edit.repo, root: edit.root });
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

async function main() {
  const event = process.argv[2];
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const ws = findWorkspace(projectDir);
  // A session started inside a listed repo gets that repo's own hooks from Claude Code.
  const startRepo = ws ? repoOf(ws, projectDir) : null;
  const edits = event === 'Stop' ? readEdits(input.session_id) : [];
  const results = [];

  if (event === 'SessionStart') {
    removeOldSessions();
    const lines = drift(ws, input, pluginVersion());
    if (lines.length) results.push({ name: 'first-pass drift check', own: true, json: { hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } } });
  }
  if (event === 'PostToolUse') recordEdit(input, ws);
  if (event === 'Stop') {
    const done = doneCheck(input, edits);
    if (done) results.push(done);
  }

  if (ws) {
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
