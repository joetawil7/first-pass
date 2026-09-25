// Drives scripts/hooks.mjs the way Claude Code does (event JSON on stdin) against a
// throwaway main folder with three repos.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'scripts', 'hooks.mjs');
const CLI = path.join(ROOT, 'scripts', 'cli.mjs');
// The start-of-session check reads the user's own Claude Code folder; the tests get an empty one.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-config-'));

let ws;
let data;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
}

function fire(event, fields, projectDir = ws) {
  const input = { session_id: 's1', prompt_id: 'p1', cwd: projectDir, hook_event_name: event, ...fields };
  const result = spawnSync('node', [HOOKS, event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_DATA: data },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const edit = (file, extra = {}) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(ws, file), old_string: 'a', new_string: 'b' }, ...extra });

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-ws-'));
  ws = path.join(base, 'ws');
  data = path.join(base, 'data');

  // api: a repo with its own session-wide guard hook (like a ticket guard).
  gitRepo(path.join(ws, 'api'));
  write(path.join(ws, 'api', 'src', 'a.ts'), 'export const a = 1;\n');
  write(
    path.join(ws, 'api', '.claude', 'hooks', 'guard.js'),
    `const fs = require('fs'); const path = require('path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const flag = path.join(process.env.CLAUDE_PROJECT_DIR, '.lockdown');
if (input.hook_event_name === 'UserPromptSubmit' && /lockdown/.test(input.prompt)) { fs.writeFileSync(flag, ''); console.log('lockdown is on'); }
if (input.hook_event_name === 'PreToolUse' && fs.existsSync(flag)) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'lockdown: no edits' } }));
}
`,
  );
  write(
    path.join(ws, 'api', '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js"' }] }] } }),
  );

  // web: a UI repo; the workspace-level design hook reports which folder it ran in.
  gitRepo(path.join(ws, 'web'));
  write(path.join(ws, 'web', 'src', 'App.tsx'), 'export const App = () => null;\n');
  write(
    path.join(ws, 'tools', 'design.js'),
    `const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const text = input.hook_event_name === 'Stop' ? 'deep pass in ' + require('path').basename(input.cwd) : 'scanned ' + require('path').basename(input.tool_input.file_path);
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } }));
`,
  );

  // other: a repo the workspace file does not list.
  gitRepo(path.join(ws, 'other'));

  write(
    path.join(ws, '.first-pass', 'workspace.json'),
    JSON.stringify({
      firstPass: 1,
      repos: [
        { name: 'api', path: 'api' },
        { name: 'web', path: 'web', ui: true },
      ],
      hooks: [
        { id: 'guard', from: 'api', scope: 'session', events: { UserPromptSubmit: '', PreToolUse: 'Edit|Write' }, command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js"', approve: true },
        { id: 'design', repos: ['web'], scope: 'files', events: { PostToolUse: 'Edit|Write', Stop: '' }, command: 'node "${FIRST_PASS_WORKSPACE}/tools/design.js"', approve: true },
      ],
    }),
  );
  write(path.join(ws, 'AGENTS.md'), '<!-- first-pass:rules:start v0.1.0 -->\nrules\n<!-- first-pass:rules:end -->\n');
  execFileSync('node', [CLI, 'record', ws]);
});

test('record stamps approvals and CI', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ws, '.first-pass', 'workspace.json'), 'utf8'));
  assert.ok(config.hooks.every((hook) => hook.approved && !('approve' in hook)));
  assert.deepEqual(Object.keys(config.hooks[0].approved.files), ['api/.claude/hooks/guard.js']);
  assert.ok(config.repos.every((repo) => typeof repo.ci.hash === 'string'));
});

test('an edit outside a covered repo runs nothing', () => {
  assert.equal(fire('PostToolUse', edit('api/src/a.ts')), null);
});

test('a files hook runs for its repo, labelled, from the repo folder', () => {
  const reply = fire('PostToolUse', edit('web/src/App.tsx'));
  assert.equal(reply.hookSpecificOutput.additionalContext, 'design in web: scanned App.tsx');
});

test('Stop runs the files hook from the edited repo, once per new edit', () => {
  const reply = fire('Stop', { stop_hook_active: false, last_assistant_message: 'Here is the change.' });
  assert.equal(reply.hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
  assert.equal(fire('Stop', { stop_hook_active: false, last_assistant_message: 'Here is the change.' }), null);
});

test('a session started inside a repo does not get that repo\'s hooks twice', () => {
  // Claude Code runs web's own hooks natively there; first-pass must not run them again.
  assert.equal(fire('PostToolUse', edit('web/src/App.tsx', { session_id: 'inside' }), path.join(ws, 'web')), null);
});

test('edits that differ only in drive-letter case run a Stop hook once', { skip: process.platform !== 'win32' }, () => {
  const lower = path.join(ws, 'web/src/App.tsx').replace(/^[A-Z]:/, (d) => d.toLowerCase());
  fire('PostToolUse', edit('web/src/App.tsx', { session_id: 'case' }));
  fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: lower }, session_id: 'case' });
  const reply = fire('Stop', { session_id: 'case', stop_hook_active: false, last_assistant_message: 'Here is the change.' });
  assert.equal(reply.hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
});

test('the done check sends back a done claim with no Verified line', () => {
  fire('PostToolUse', edit('api/src/a.ts', { prompt_id: 'p2' }));
  const reply = fire('Stop', { prompt_id: 'p2', stop_hook_active: false, last_assistant_message: 'Fixed.' });
  assert.match(reply.hookSpecificOutput.additionalContext, /done check: this turn changed 1 code file\(s\) \(api\/src\/a\.ts\)/);
  assert.equal(fire('Stop', { prompt_id: 'p2', stop_hook_active: false, last_assistant_message: 'Fixed.\nVerified: npm test → 3 passed' }), null);
});

test('a session hook sees every prompt and guards edits in any repo', () => {
  const prompt = fire('UserPromptSubmit', { prompt: 'lockdown please' });
  assert.equal(prompt.hookSpecificOutput.additionalContext, 'lockdown is on');
  const denied = fire('PreToolUse', edit('web/src/App.tsx'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason, 'lockdown: no edits');
  assert.equal(fire('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(ws, 'api/src/a.ts') } }), null);
});

test('a hook whose script changed after approval is paused, and says so once', () => {
  const guard = path.join(ws, 'api', '.claude', 'hooks', 'guard.js');
  fs.appendFileSync(guard, '// changed\n');
  const first = fire('PreToolUse', edit('web/src/App.tsx', { session_id: 's2' }));
  assert.match(first.systemMessage, /guard \(api\) hook is paused because api\/\.claude\/hooks\/guard\.js changed since it was approved/);
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined, 'a paused guard does not deny');
  assert.match(first.hookSpecificOutput.additionalContext, /guard \(api\) hook is paused/, 'Claude is told too');
  assert.equal(fire('PreToolUse', edit('web/src/App.tsx', { session_id: 's2' })), null);
});

test('the start-of-session check lists what drifted', () => {
  const reply = fire('SessionStart', { source: 'compact' });
  const text = reply.hookSpecificOutput.additionalContext;
  assert.match(text, /context was just compacted/);
  assert.match(text, /rules block in the workspace\/AGENTS\.md is v0\.1\.0/);
  assert.match(text, /other is a git repo in the workspace that workspace\.json does not list/);
  assert.match(text, /guard hook for api is paused/);
});

test('without a workspace file only the done and drift checks run', () => {
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-lone-'));
  gitRepo(path.join(lone, 'x'));
  gitRepo(path.join(lone, 'y'));
  const result = spawnSync('node', [HOOKS, 'SessionStart'], {
    input: JSON.stringify({ session_id: 's3', cwd: lone, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: lone, CLAUDE_PLUGIN_DATA: data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /holds 2 git repos and has no first-pass setup/);
});
