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
  // A prompt of its own: the done check fires once per prompt, so p2 would be quiet anyway.
  fire('PostToolUse', edit('api/src/a.ts', { prompt_id: 'p2b' }));
  assert.equal(fire('Stop', { prompt_id: 'p2b', stop_hook_active: false, last_assistant_message: 'Fixed.\nVerified: npm test → 3 passed' }), null);
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

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
// A shell run as Claude Code reports it: PreToolUse, then what the command did, then PostToolUse.
function shellRun(command, does, extra = {}, projectDir = ws) {
  const id = `toolu_${Math.random().toString(36).slice(2)}`;
  const pre = fire('PreToolUse', bash(command, { tool_use_id: id, ...extra }), projectDir);
  does();
  fire('PostToolUse', bash(command, { tool_use_id: id, ...extra }), projectDir);
  return pre;
}
const stop = (extra) => fire('Stop', { stop_hook_active: false, last_assistant_message: 'Done.', ...extra });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a file a shell command changed counts for the done check', () => {
  shellRun("sed -i 's/1/22/' api/src/a.ts", () => fs.writeFileSync(path.join(ws, 'api', 'src', 'a.ts'), 'export const a = 22;\n'), { session_id: 'sh1' });
  const reply = stop({ session_id: 'sh1', last_assistant_message: 'Fixed.' });
  assert.match(reply.hookSpecificOutput.additionalContext, /done check: this turn changed 1 code file\(s\) \(api\/src\/a\.ts\)/);
});

test('a shell command that changes nothing, or only commits, counts for nothing', () => {
  const api = path.join(ws, 'api');
  write(path.join(api, 'src', 'b.ts'), 'export const b = 1;\n');
  shellRun('git add src/b.ts && git commit -m b', () => {
    execFileSync('git', ['-C', api, 'add', 'src/b.ts']);
    execFileSync('git', ['-C', api, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'b']);
  }, { session_id: 'sh2', cwd: api });
  assert.equal(stop({ session_id: 'sh2' }), null);
  shellRun('ls src', () => {}, { session_id: 'sh2', prompt_id: 'p2', cwd: api });
  assert.equal(stop({ session_id: 'sh2', prompt_id: 'p2' }), null);
});

test('a git reset that rewrites no file counts for nothing', () => {
  const api = path.join(ws, 'api');
  write(path.join(api, 'src', 'c.ts'), 'export const c = 1;\n');
  execFileSync('git', ['-C', api, 'add', 'src/c.ts']);
  execFileSync('git', ['-C', api, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'c']);
  sleep(2500);
  shellRun('git reset HEAD~1', () => execFileSync('git', ['-C', api, 'reset', '-q', 'HEAD~1']), { session_id: 'sh6', cwd: api });
  assert.equal(stop({ session_id: 'sh6' }), null);
});

test('a change or delete made outside every shell run (an editor, another session) counts for nothing', () => {
  const scratch = path.join(ws, 'web', 'src', 'scratch.ts');
  write(scratch, 'x\n');
  shellRun('git -C web log -1', () => {}, { session_id: 'sh7' });
  sleep(2500);
  fs.appendFileSync(path.join(ws, 'web', 'src', 'App.tsx'), '// saved in an editor\n');
  fs.rmSync(scratch);
  assert.equal(stop({ session_id: 'sh7' }), null);
});

test('a run that failed, or that a hook denied, ends there: later outside changes count for nothing', () => {
  const app = path.join(ws, 'web', 'src', 'App.tsx');
  const id = 'toolu_failed';
  fire('PreToolUse', bash('cd web && npm test', { session_id: 'sh13', tool_use_id: id }));
  fire('PostToolUseFailure', bash('cd web && npm test', { session_id: 'sh13', tool_use_id: id, error: 'exit 1' }));
  sleep(2500);
  fs.appendFileSync(app, '// saved in an editor\n');
  assert.equal(stop({ session_id: 'sh13' }), null);

  // A second main folder whose guard denies every shell command.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-deny-'));
  gitRepo(path.join(other, 'r'));
  write(path.join(other, 'r', 'f.js'), 'x\n');
  write(path.join(other, 'r', 'deny.js'), `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no shell' } }));\n`);
  write(path.join(other, '.first-pass', 'workspace.json'), JSON.stringify({ firstPass: 1, repos: [{ name: 'r', path: 'r' }], hooks: [{ id: 'noshell', from: 'r', scope: 'session', events: { PreToolUse: 'Bash' }, command: 'node "${CLAUDE_PROJECT_DIR}/deny.js"', approve: true }] }));
  execFileSync('node', [CLI, 'record', other]);
  const denied = fire('PreToolUse', bash('cd r && make', { session_id: 'sh14', tool_use_id: 'toolu_denied' }), other);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  sleep(2500);
  fs.appendFileSync(path.join(other, 'r', 'f.js'), 'y\n');
  assert.equal(fire('Stop', { session_id: 'sh14', stop_hook_active: false, last_assistant_message: 'Done.' }, other), null);
});

test('a refused command (no end reported) ends at the next prompt at the latest', () => {
  fire('PreToolUse', bash('cd web && touch x', { session_id: 'sh15', tool_use_id: 'toolu_refused' }));
  fire('UserPromptSubmit', { session_id: 'sh15', prompt_id: 'p2', prompt: 'next' });
  sleep(2500);
  fs.appendFileSync(path.join(ws, 'web', 'src', 'App.tsx'), '// saved in an editor\n');
  assert.equal(stop({ session_id: 'sh15', prompt_id: 'p2' }), null);
});

test('copies that keep old times, and a delete, inside a run are seen', () => {
  const app = path.join(ws, 'web', 'src', 'App.tsx');
  const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-copy-')), 'App.old.tsx');
  write(source, 'export const App = () => "old";\n');
  const gone = path.join(ws, 'web', 'src', 'gone.ts');
  write(gone, 'x\n');
  // Older than any run's slack, so only the copy itself can date the change.
  sleep(2500);
  // copyFileSync over a file keeps the source's mtime and ctime on Windows, as Copy-Item does.
  shellRun(`Copy-Item "${source}" web/src/App.tsx`, () => fs.copyFileSync(source, app), { session_id: 'sh16', tool_name: 'PowerShell' });
  assert.equal(stop({ session_id: 'sh16', last_assistant_message: 'Here is the change.' }).hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
  // `cp -p` keeps the mtime; a copy to a new file keeps it too on Windows.
  shellRun(`cp -p "${source}" web/src/Copy.tsx`, () => {
    fs.copyFileSync(source, path.join(ws, 'web', 'src', 'Copy.tsx'));
    fs.utimesSync(path.join(ws, 'web', 'src', 'Copy.tsx'), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  }, { session_id: 'sh16', prompt_id: 'p2' });
  assert.match(stop({ session_id: 'sh16', prompt_id: 'p2', last_assistant_message: 'Copied it.\nDone.' }).hookSpecificOutput.additionalContext, /\(web\/src\/Copy\.tsx\)/);
  shellRun('rm web/src/gone.ts', () => fs.rmSync(gone), { session_id: 'sh16', prompt_id: 'p3' });
  assert.match(stop({ session_id: 'sh16', prompt_id: 'p3', last_assistant_message: 'Removed it.\nDone.' }).hookSpecificOutput.additionalContext, /\(web\/src\/gone\.ts\)/);
});

test('an end-of-turn repo hook runs for a repo a shell command changed', () => {
  shellRun('cd web && npx prettier --write src/App.tsx', () => fs.appendFileSync(path.join(ws, 'web', 'src', 'App.tsx'), '// formatted\n'), { session_id: 'sh3' });
  const reply = stop({ session_id: 'sh3', last_assistant_message: 'Here is the change.' });
  assert.equal(reply.hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
});

test('a shell change after a send-back is seen at the next Stop', () => {
  const app = path.join(ws, 'web', 'src', 'App.tsx');
  shellRun('cd web && npx prettier --write src/App.tsx', () => fs.appendFileSync(app, '// one\n'), { session_id: 'sh8' });
  assert.equal(stop({ session_id: 'sh8', last_assistant_message: 'Here is the change.' }).hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
  shellRun("cd web && sed -i 's/one/two/' src/App.tsx", () => fs.appendFileSync(app, '// two\n'), { session_id: 'sh8' });
  const again = stop({ session_id: 'sh8', stop_hook_active: true, last_assistant_message: 'Here is the fix.' });
  assert.equal(again.hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
});

test('a shell change in a prompt that never reached Stop is seen at the next one, as that prompt\'s', () => {
  shellRun('cd web && npx prettier --write src/App.tsx', () => fs.appendFileSync(path.join(ws, 'web', 'src', 'App.tsx'), '// interrupted\n'), { session_id: 'sh9', prompt_id: 'p1' });
  const reply = stop({ session_id: 'sh9', prompt_id: 'p2', last_assistant_message: 'Here is the answer.' });
  assert.equal(reply.hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
  const edits = fs.readFileSync(path.join(data, 'sessions', 'sh9', 'edits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(edits.map((edit) => [edit.prompt, edit.tool, edit.rel]), [['p1', 'shell', 'web/src/App.tsx']]);
});

test('a //host path in a command is never looked up, and the edit is still seen', () => {
  const started = Date.now();
  const pre = shellRun(`cat > web/src/App.tsx <<'EOF'\n<link href="//nohost.invalid/x.css">\nEOF`, () => fs.writeFileSync(path.join(ws, 'web', 'src', 'App.tsx'), '<link href="//nohost.invalid/x.css">\n'), { session_id: 'sh10' });
  assert.equal(pre, null);
  assert.ok(Date.now() - started < 10_000, 'no network lookup');
  assert.equal(stop({ session_id: 'sh10', last_assistant_message: 'Here is the change.' }).hookSpecificOutput.additionalContext, 'design in web: deep pass in web');
});

test('a Git Bash path (/c/...) in a shell command finds its repo', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(ws, 'api', 'src', 'a.ts');
  const gitBash = `/${file[0].toLowerCase()}${file.slice(2).replace(/\\/g, '/')}`;
  shellRun(`sed -i 's/22/333/' ${gitBash}`, () => fs.writeFileSync(file, 'export const a = 333;\n'), { session_id: 'sh4' });
  assert.match(stop({ session_id: 'sh4', last_assistant_message: 'Fixed.' }).hookSpecificOutput.additionalContext, /\(api\/src\/a\.ts\)/);
});

test('a Git Bash cd (/c/...) from one repo into another is followed', { skip: process.platform !== 'win32' }, () => {
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-lone-'));
  const [a, b] = [path.join(lone, 'a'), path.join(lone, 'b')];
  gitRepo(a);
  gitRepo(b);
  write(path.join(b, 'x.js'), 'x\n');
  const gitBash = `/${b[0].toLowerCase()}${b.slice(2).replace(/\\/g, '/')}`;
  shellRun(`cd ${gitBash} && sed -i s/x/yy/ x.js`, () => fs.writeFileSync(path.join(b, 'x.js'), 'yy\n'), { session_id: 'sh17', cwd: a }, a);
  const reply = fire('Stop', { session_id: 'sh17', stop_hook_active: false, last_assistant_message: 'Fixed.' }, a);
  assert.match(reply.hookSpecificOutput.additionalContext, /done check: this turn changed 1 code file\(s\) \(b\/x\.js\)/);
});

test('a repo git cannot read is said once, never taken as unchanged', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-broken-'));
  write(path.join(broken, '.git'), 'gitdir: nowhere\n');
  const first = fire('PreToolUse', bash('make', { session_id: 'sh5', cwd: broken }), broken);
  assert.match(first.systemMessage, /could not read git status in .*first-pass-broken-.*so files a shell command changed there are not seen/);
  assert.equal(fire('PreToolUse', bash('make', { session_id: 'sh5', prompt_id: 'p2', cwd: broken }), broken), null);
});

test('a repo removed during the turn (a temp worktree) ends quietly', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-worktree-'));
  gitRepo(temp);
  shellRun('npm test', () => write(path.join(temp, 'x.js'), 'x\n'), { session_id: 'sh11', cwd: temp }, temp);
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(fire('Stop', { session_id: 'sh11', stop_hook_active: false, last_assistant_message: 'Here it is.' }, temp), null);
});

test('a saved git status cut short is reported, and the next command notes the repo afresh', () => {
  shellRun('git -C web status', () => {}, { session_id: 'sh12' });
  const dir = path.join(data, 'sessions', 'sh12');
  const note = fs.readdirSync(dir).find((name) => name.startsWith('shell-note-'));
  fs.writeFileSync(path.join(dir, note), '{"root":');
  assert.match(stop({ session_id: 'sh12' }).systemMessage, /a saved git status could not be read/);
  assert.equal(fs.existsSync(path.join(dir, note)), false);
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
