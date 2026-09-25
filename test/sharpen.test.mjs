// sharpen's gate, driven through scripts/hooks.mjs the way Claude Code runs it, against
// throwaway transcripts in the system temp folder.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATED_TOOLS, MAX_CALLS, MAX_REPLIES } from '../scripts/lib/sharpen-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'scripts', 'hooks.mjs');
const CLI = path.join(ROOT, 'scripts', 'cli.mjs');
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-config-'));

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-sharpen-'));
  const transcript = path.join(base, 'session.jsonl');
  // An earlier turn already showed a rewrite: it must not release this turn's gate.
  fs.writeFileSync(transcript, row('assistant', '**Sharpened**\n\nGoal: an earlier prompt'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, transcript, project, data: path.join(base, 'data') };
}

let messages = 0;
function row(type, text, extra = {}) {
  return JSON.stringify({ type, message: { id: `msg_${++messages}`, role: type, content: [{ type: 'text', text }] }, ...extra }) + '\n';
}

function hookInput(env, event, fields) {
  return JSON.stringify({ session_id: 's1', prompt_id: 'p1', cwd: env.project, transcript_path: env.transcript, hook_event_name: event, ...fields });
}
const hookEnv = (env) => ({ ...process.env, CLAUDE_PROJECT_DIR: env.project, CLAUDE_PLUGIN_DATA: env.data });

function fire(env, event, fields) {
  const result = spawnSync('node', [HOOKS, event], { input: hookInput(env, event, fields), encoding: 'utf8', env: hookEnv(env) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

// Like fire, but without waiting: for hooks Claude Code runs at the same time.
function fireAsync(env, event, fields) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOKS, event], { env: hookEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(hookInput(env, event, fields));
  });
}

const tool = (name, extra = {}) => ({ tool_name: name, tool_input: { file_path: 'x' }, ...extra });
const denied = (reply) => reply?.hookSpecificOutput?.permissionDecision === 'deny';

test('a sharpen prompt holds back edits, commands and skills until the rewrite is shown', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart and be 100% sure' });
  const edit = fire(env, 'PreToolUse', tool('Edit'));
  assert.ok(denied(edit));
  assert.match(edit.hookSpecificOutput.permissionDecisionReason, /no saved reply text shows the rewrite yet\. .*end the message there, with no tool call/);
  assert.equal(fire(env, 'PreToolUse', tool('Read')), null, 'reading stays free');
  assert.ok(denied(fire(env, 'PreToolUse', tool('Skill'))));

  fs.appendFileSync(env.transcript, row('assistant', 'Looking at the files first.'));
  assert.ok(denied(fire(env, 'PreToolUse', tool('Bash'))), 'other text does not count');
  fs.appendFileSync(env.transcript, row('assistant', '**Sharpened**\n\nGoal: fix the cart'));
  assert.equal(fire(env, 'PreToolUse', tool('Edit')), null);
  assert.equal(fire(env, 'PreToolUse', tool('Agent')), null);
});

test("a subagent's text does not count as the rewrite, and a subagent is never gated", () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart' });
  fs.appendFileSync(env.transcript, row('assistant', 'Sharpened', { isSidechain: true }));
  assert.ok(denied(fire(env, 'PreToolUse', tool('Edit'))));
  assert.equal(fire(env, 'PreToolUse', tool('Edit', { agent_id: 'a1' })), null);
});

test('it gives up after the most replies, not calls, and the turn still ends asking for the rewrite', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart' });
  // Four edits in one message: all held, and they cost that one reply, not the allowance.
  for (let i = 0; i < 4; i++) assert.ok(denied(fire(env, 'PreToolUse', tool('Edit'))));
  for (let reply = 1; reply < MAX_REPLIES; reply++) {
    fs.appendFileSync(env.transcript, row('assistant', `Trying again, reply ${reply}.`));
    assert.ok(denied(fire(env, 'PreToolUse', tool('Edit'))), `reply ${reply} is still held`);
  }
  fs.appendFileSync(env.transcript, row('assistant', 'Trying again.'));
  const through = fire(env, 'PreToolUse', tool('Edit'));
  assert.ok(!denied(through));
  assert.match(through.systemMessage, /rewrite was not shown before the work started/);
  assert.equal(fire(env, 'PreToolUse', tool('Edit')), null);
  const back = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'Done the work.' });
  assert.match(back.hookSpecificOutput.additionalContext, /no reply showed the rewrite/);
  assert.equal(fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'Done the work.' }), null);
});

test('with no transcript to read, it still gives up after the most calls', () => {
  const env = setup();
  const missing = { transcript_path: path.join(env.base, 'no-such.jsonl') };
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart', ...missing });
  for (let i = 0; i < MAX_CALLS; i++) assert.ok(denied(fire(env, 'PreToolUse', tool('Edit', missing))));
  assert.ok(!denied(fire(env, 'PreToolUse', tool('Edit', missing))));
});

test('MCP tools, other agents, publishing and scheduling are held back too', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen publish the draft' });
  for (const name of ['mcp__blog__publish_post', 'SendMessage', 'Workflow', 'Artifact', 'RemoteTrigger', 'CronCreate']) {
    assert.ok(denied(fire(env, 'PreToolUse', tool(name))), name);
  }
});

test('a rewrite that stops to ask ends the turn there, with no send-back', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen delete the old users' });
  const asked = '**Sharpened**\n\n1. Delete the old users (change)\n\n**Before I start:**\n1. Which database? Default: none.';
  assert.equal(fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: asked }), null);
});

test('the done check still runs on the work done after sharpen sends the model back', () => {
  const env = setup();
  execFileSync('git', ['init', '-q', env.project]);
  const file = path.join(env.project, 'src', 'cart.ts');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'export const total = 1;\n');
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart total' });
  const go = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: '**Sharpened**\n\nGoal: fix the cart' });
  assert.match(go.hookSpecificOutput.additionalContext, /Now do the work from it/);
  const edit = { tool_name: 'Edit', tool_input: { file_path: file, old_string: '1', new_string: '2' } };
  assert.equal(fire(env, 'PreToolUse', edit), null);
  fire(env, 'PostToolUse', edit);
  // Claude Code keeps stop_hook_active on for the rest of a turn a Stop hook sent back.
  const done = fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: 'Fixed the cart total.' });
  assert.match(done.hookSpecificOutput.additionalContext, /done check: this turn changed 1 code file/);
  assert.equal(fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: 'Fixed the cart total.' }), null, 'once');
});

test('after the "never shown" send-back too, the done check runs once on the Stop that ends the work', () => {
  const env = setup();
  execFileSync('git', ['init', '-q', env.project]);
  const file = path.join(env.project, 'src', 'cart.ts');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'export const total = 1;\n');
  const edit = { tool_name: 'Edit', tool_input: { file_path: file, old_string: '1', new_string: '2' } };
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart total' });
  assert.ok(denied(fire(env, 'PreToolUse', edit)));
  for (let reply = 0; reply < MAX_REPLIES; reply++) fs.appendFileSync(env.transcript, row('assistant', 'Working on it.'));
  assert.ok(!denied(fire(env, 'PreToolUse', edit)), 'gave up');
  fire(env, 'PostToolUse', edit);
  const back = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'Here is the change.' });
  assert.match(back.hookSpecificOutput.additionalContext, /no reply showed the rewrite/);
  assert.doesNotMatch(back.hookSpecificOutput.additionalContext, /done check/);
  fire(env, 'PostToolUse', edit);
  const done = fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: '**Sharpened**\n\nGoal: fix it. Fixed.' });
  assert.match(done.hookSpecificOutput.additionalContext, /done check: this turn changed 1 code file/);
  assert.equal(fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: 'Fixed.' }), null);
});

test('the done check fires once per prompt, even when a later Stop is shown as a first one', () => {
  const env = setup();
  execFileSync('git', ['init', '-q', env.project]);
  const file = path.join(env.project, 'a.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  const edit = { tool_name: 'Edit', tool_input: { file_path: file, old_string: '1', new_string: '2' } };
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix a' });
  for (let reply = 0; reply <= MAX_REPLIES; reply++) {
    fire(env, 'PreToolUse', edit);
    fs.appendFileSync(env.transcript, row('assistant', 'Working on it.'));
  }
  fire(env, 'PostToolUse', edit);
  const first = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'Fixed.' });
  assert.match(first.hookSpecificOutput.additionalContext, /done check/);
  assert.match(first.hookSpecificOutput.additionalContext, /no reply showed the rewrite/);
  assert.equal(fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: 'Fixed.' }), null);
});

test('a reply with many parallel calls costs one reply of the allowance', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart' });
  for (let reply = 0; reply < MAX_REPLIES; reply++) {
    for (let call = 0; call < 6; call++) assert.ok(denied(fire(env, 'PreToolUse', tool('Write'))), `reply ${reply}, call ${call}`);
    fs.appendFileSync(env.transcript, row('assistant', 'Trying again.'));
  }
  assert.ok(!denied(fire(env, 'PreToolUse', tool('Write'))));
});

test('hooks running at the same time never fail on the shared record', async () => {
  const env = setup();
  const failures = [];
  for (let round = 0; round < 20; round++) {
    // Re-armed each round, so every round's hooks all write the record.
    fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart', prompt_id: `r${round}` });
    const runs = await Promise.all(Array.from({ length: 6 }, () => fireAsync(env, 'PreToolUse', { prompt_id: `r${round}`, tool_name: 'Bash', tool_input: { command: 'ls' } })));
    for (const run of runs) {
      if (run.status !== 0 || /failed and was skipped/.test(run.stdout)) failures.push(run.stderr || run.stdout);
      else assert.ok(denied(JSON.parse(run.stdout)), 'each call was checked and held');
    }
  }
  assert.deepEqual(failures, []);
});

test('the start-of-session cleanup never fails on a live session renaming its record', async () => {
  const env = setup();
  process.env.CLAUDE_PLUGIN_DATA = env.data;
  const state = new URL('../scripts/lib/state.mjs', import.meta.url).href;
  const writer = spawn('node', ['--input-type=module', '-e', `import { writeRecord } from '${state}'; for (let i = 0; i < 1500; i++) writeRecord('live', 'sharpen', i % 3 ? { i } : null);`], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data },
  });
  const finished = new Promise((resolve) => writer.on('close', resolve));
  const { removeOldSessions } = await import('../scripts/lib/state.mjs');
  const errors = [];
  let exited = false;
  finished.then(() => (exited = true));
  while (!exited) {
    try {
      removeOldSessions();
    } catch (error) {
      errors.push(error.code);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await finished, 0);
  assert.deepEqual(errors, []);
});

test('only a sharpen prompt with text arms it, and only for that prompt', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen' });
  assert.equal(fire(env, 'PreToolUse', tool('Edit')), null, 'with no prompt the skill asks for one');

  fire(env, 'UserPromptSubmit', { prompt: '/sharpen tidy this up', prompt_id: 'p2' });
  assert.ok(denied(fire(env, 'PreToolUse', tool('Edit', { prompt_id: 'p2' }))), 'the bare name works too');
  assert.equal(fire(env, 'PreToolUse', tool('Edit', { prompt_id: 'p1' })), null, 'another prompt is not gated');

  fire(env, 'UserPromptSubmit', { prompt: 'thanks, go ahead', prompt_id: 'p3' });
  assert.equal(fire(env, 'PreToolUse', tool('Edit', { prompt_id: 'p3' })), null);
  assert.equal(fs.existsSync(path.join(env.data, 'sessions', 's1', 'sharpen.json')), false, 'a new prompt ends it');
  assert.equal(fire(env, 'UserPromptSubmit', { prompt: 'please sharpen your wording' }), null);
});

test('a turn that ends without showing the rewrite is sent back once', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen what does checkout do, be 100% sure' });
  const back = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'It adds VAT.' });
  assert.match(back.hookSpecificOutput.additionalContext, /no reply showed the rewrite/);
  assert.equal(fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'It adds VAT.' }), null);

  // Shown next to a tool call, and the work already ran: nothing to add.
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen what does checkout do', prompt_id: 'p2' });
  fs.appendFileSync(env.transcript, row('assistant', '**Sharpened: already clear, working from it as written.**'));
  assert.equal(fire(env, 'PreToolUse', tool('Bash', { prompt_id: 'p2' })), null);
  assert.equal(fire(env, 'Stop', { prompt_id: 'p2', stop_hook_active: false, last_assistant_message: 'It adds VAT.' }), null);
});

test('a rewrite that ends its message lets the work go on, even before the transcript has it', () => {
  const env = setup();
  fire(env, 'UserPromptSubmit', { prompt: '/first-pass:sharpen fix the cart and dont break anything' });
  assert.ok(denied(fire(env, 'PreToolUse', tool('Skill'))));
  const go = fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: '**Sharpened**\n\nGoal: fix the cart' });
  assert.match(go.hookSpecificOutput.additionalContext, /the rewrite is shown\. Now do the work from it/);
  assert.equal(fire(env, 'PreToolUse', tool('Skill')), null);
  assert.equal(fire(env, 'PreToolUse', tool('Edit')), null);
  assert.equal(fire(env, 'Stop', { stop_hook_active: true, last_assistant_message: 'Fixed.' }), null);
  assert.equal(fire(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'Report.' }), null, 'said once');
});

test('the gated tools are the ones hooks/hooks.json sends to PreToolUse', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const matchers = hooks.PreToolUse.map((group) => group.matcher);
  const named = new Set(matchers.filter((m) => m !== 'mcp__.*').flatMap((m) => m.split('|')));
  assert.deepEqual([...named].sort(), [...GATED_TOOLS].sort());
  assert.ok(matchers.includes('mcp__.*'), 'MCP tools reach the gate');
});

test('repo hooks run from the main folder never see the tools added for the gate', () => {
  const env = setup();
  const api = path.join(env.project, 'api');
  fs.mkdirSync(path.join(api, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', api]);
  fs.writeFileSync(path.join(api, '.claude', 'every.js'), "console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'every tool' } }));\n");
  fs.mkdirSync(path.join(env.project, '.first-pass'));
  fs.writeFileSync(
    path.join(env.project, '.first-pass', 'workspace.json'),
    JSON.stringify({
      firstPass: 1,
      repos: [{ name: 'api', path: 'api' }],
      hooks: [{ id: 'every', from: 'api', scope: 'session', events: { PreToolUse: '' }, command: 'node "${CLAUDE_PROJECT_DIR}/.claude/every.js"', approve: true }],
    }),
  );
  execFileSync('node', [CLI, 'record', env.project]);
  assert.equal(fire(env, 'PreToolUse', tool('Skill')), null);
  assert.equal(fire(env, 'PreToolUse', tool('Agent')), null);
  assert.equal(fire(env, 'PreToolUse', tool('mcp__blog__publish_post')), null);
  assert.match(fire(env, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }).hookSpecificOutput.additionalContext, /every tool/);
});
