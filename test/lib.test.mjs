import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EVENT_LIMITS, effectiveTimeout, hookProblems, matches, runHook, selectRuns } from '../scripts/lib/bridge.mjs';
import { ciCommands, ciHash } from '../scripts/lib/ci.mjs';
import { checkCursorRules, imports, syncCursorRules } from '../scripts/lib/cursor-rules.mjs';
import { claimWord, doneCheck } from '../scripts/lib/done-check.mjs';
import { compareVersions } from '../scripts/lib/drift.mjs';
import { approval, whyPaused } from '../scripts/lib/fingerprint.mjs';
import { CONTEXT_CAP, merge } from '../scripts/lib/merge.mjs';
import { isInside } from '../scripts/lib/paths.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-test-'));
}

test('matchers follow Claude Code: exact lists, regex otherwise, empty matches all', () => {
  assert.equal(matches('Edit|Write', 'Write'), true);
  assert.equal(matches('Edit|Write', 'NotebookEdit'), false);
  assert.equal(matches('Edit, Write', 'Edit'), true);
  assert.equal(matches('^Notebook', 'NotebookEdit'), true);
  assert.equal(matches('Edit.*', 'NotebookEdit'), true);
  assert.equal(matches('', 'Anything'), true);
  assert.equal(matches('*', 'Anything'), true);
  assert.equal(matches(undefined, 'Anything'), true);
});

test('isInside does not confuse a folder with a sibling that starts the same', () => {
  assert.equal(isInside('/w/shop-website/a.ts', '/w/shop'), false);
  assert.equal(isInside('/w/shop/a.ts', '/w/shop'), true);
  assert.equal(isInside('/w/shop', '/w/shop'), true);
});

test('PreToolUse: deny beats ask beats allow, and exit 2 is a deny', () => {
  const reply = merge('PreToolUse', [
    { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) },
    { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check' } }) },
    { status: 2, stdout: '', stderr: 'no edits in ticket mode' },
  ]);
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(reply.hookSpecificOutput.permissionDecisionReason, 'no edits in ticket mode');

  const ask = merge('PreToolUse', [
    { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check' } }) },
    { status: 0, stdout: '' },
  ]);
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
});

test('decision events: a block from any hook blocks, and every context reaches Claude with its label', () => {
  const reply = merge('Stop', [
    { label: 'design in web', status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'gradient text in a.tsx' } }) },
    { label: 'design in app', status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'bounce easing in b.tsx' } }) },
    { status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'run the tests' }) },
  ]);
  assert.equal(reply.decision, 'block');
  assert.equal(reply.reason, 'run the tests');
  assert.match(reply.hookSpecificOutput.additionalContext, /design in web: gradient text/);
  assert.match(reply.hookSpecificOutput.additionalContext, /design in app: bounce easing/);
});

test('plain text counts as context only where Claude Code treats it so', () => {
  assert.equal(merge('UserPromptSubmit', [{ status: 0, stdout: 'ticket mode is on' }]).hookSpecificOutput.additionalContext, 'ticket mode is on');
  assert.equal(merge('PostToolUse', [{ status: 0, stdout: 'ignored' }]), null);
});

test('failures are visible: bad JSON, a crash and a timeout each become a message', () => {
  const reply = merge('PostToolUse', [
    { name: 'a', status: 0, stdout: '{not json}' },
    { name: 'b', status: 1, stdout: '', stderr: 'boom\nstack' },
    { name: 'c', timedOut: true },
  ]);
  assert.match(reply.systemMessage, /a printed invalid JSON/);
  assert.match(reply.systemMessage, /b failed \(exit 1\): boom/);
  assert.match(reply.systemMessage, /c timed out/);
});

test('no output from any hook means no reply', () => {
  assert.equal(merge('PreToolUse', [{ status: 0, stdout: '' }]), null);
  assert.equal(merge('Stop', []), null);
});

test('an approval pins the hook and its script; a change to either pauses it', () => {
  const root = tempDir();
  const repo = path.join(root, 'api');
  fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
  const script = path.join(repo, '.claude', 'hooks', 'guard.js');
  fs.writeFileSync(script, 'process.exit(0)');
  const hook = { id: 'guard', scope: 'session', from: 'api', events: { PreToolUse: 'Edit' }, command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js"' };

  assert.equal(whyPaused(hook, repo, root), 'it has not been approved');
  hook.approved = approval(hook, [repo], root);
  assert.deepEqual(Object.keys(hook.approved.files), ['api/.claude/hooks/guard.js']);
  assert.equal(whyPaused(hook, repo, root), null);

  fs.writeFileSync(script, 'process.exit(2)');
  assert.match(whyPaused(hook, repo, root), /guard\.js changed since it was approved/);
  fs.writeFileSync(script, 'process.exit(0)');
  assert.equal(whyPaused({ ...hook, events: { PreToolUse: 'Edit|Bash' } }, repo, root), 'its definition changed since it was approved');
});

test('cursor rules: an .mdc import is reported, synced to a copy, and then checks clean', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'core.mdc'), '---\nalwaysApply: true\n---\n\n# Core\nNever do X.\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Rules\n\n@.cursor/rules/core.mdc\n');

  assert.deepEqual(imports(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')), ['.cursor/rules/core.mdc']);
  assert.match(checkCursorRules(repo)[0], /never loads \.mdc imports/);

  const changes = syncCursorRules(repo);
  assert.deepEqual(changes, ['CLAUDE.md: @.cursor/rules/core.mdc → @.claude/cursor-rules/core.md', '.claude/cursor-rules/core.md written']);
  assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), /@\.claude\/cursor-rules\/core\.md/);
  assert.match(fs.readFileSync(path.join(repo, '.claude', 'cursor-rules', 'core.md'), 'utf8'), /^<!-- Generated from[\s\S]*# Core\nNever do X\.\n$/);
  assert.deepEqual(checkCursorRules(repo), []);
  assert.deepEqual(syncCursorRules(repo), [], 'a second sync changes nothing');

  fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'core.mdc'), '---\nalwaysApply: true\n---\n\n# Core\nNever do Y.\n');
  assert.match(checkCursorRules(repo)[0], /out of date/);
});

test('cursor rules: a copy written by another tool keeps its own header when refreshed', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.cursor', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude', 'cursor-rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'a.mdc'), '---\nalwaysApply: true\n---\nNew text\n');
  fs.writeFileSync(path.join(repo, '.claude', 'cursor-rules', 'a.md'), '<!-- Generated by our own script. -->\n\nOld text\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@.claude/cursor-rules/a.md\n');
  syncCursorRules(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'cursor-rules', 'a.md'), 'utf8'), '<!-- Generated by our own script. -->\n\nNew text\n');
});

test('CI commands: single lines, blocks and lists, with their job', () => {
  const workflow = [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: pnpm lint:check',
    '      - name: Types',
    '        run: |',
    '          pnpm typecheck',
    '          pnpm build',
    '  test:',
    '    steps:',
    '      - run: "pnpm test"',
  ].join('\n');
  assert.deepEqual(ciCommands(workflow), [
    { job: 'lint', command: 'pnpm lint:check' },
    { job: 'lint', command: 'pnpm typecheck\npnpm build' },
    { job: 'test', command: 'pnpm test' },
  ]);
  assert.deepEqual(ciCommands('test:\n  script:\n    - npm ci\n    - npm test\n'), [{ job: null, command: 'npm ci\nnpm test' }]);
});

test('the CI hash changes when a workflow changes, not with line endings', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: x\n');
  const before = ciHash(repo);
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\r\n  a:\r\n    steps:\r\n      - run: x\r\n');
  assert.equal(ciHash(repo), before);
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: y\n');
  assert.notEqual(ciHash(repo), before);
});

test('done check: claim words, and the negations that are not claims', () => {
  assert.equal(claimWord('Fixed the race in the claim path.'), 'Fixed');
  assert.equal(claimWord('Built, not done: the flow test is missing.'), null);
  assert.equal(claimWord('It has not been verified yet.'), null);
  assert.equal(claimWord("This isn't working yet."), null);
  assert.equal(claimWord('Not verified: the e2e run.'), null);
  assert.equal(claimWord('Here is the plan.'), null);
});

test('done check: fires only for code changed this turn, with a claim and no Verified line', () => {
  const edits = [
    { prompt: 'p1', file: '/w/api/src/a.ts', rel: 'api/src/a.ts' },
    { prompt: 'p0', file: '/w/api/src/old.ts', rel: 'api/src/old.ts' },
    { prompt: 'p2', file: '/w/api/README.md', rel: 'api/README.md' },
  ];
  const base = { prompt_id: 'p1', last_assistant_message: 'Done. The retry now checks first.' };
  const hit = doneCheck(base, edits);
  assert.match(hit.json.hookSpecificOutput.additionalContext, /changed 1 code file\(s\) \(api\/src\/a\.ts\)/);
  assert.equal(doneCheck({ ...base, last_assistant_message: 'Done.\nVerified: pnpm test → 12 passed' }, edits), null);
  assert.equal(doneCheck({ ...base, stop_hook_active: true }, edits), null);
  assert.equal(doneCheck({ ...base, prompt_id: 'p2' }, edits), null, 'docs only');
  assert.equal(doneCheck({ ...base, prompt_id: 'p9' }, edits), null, 'nothing changed this turn');
  assert.equal(doneCheck({ ...base, agent_id: 'x' }, edits), null);
});

test('bridged hooks get less time than first-pass itself, on every event', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  for (const [event, limit] of Object.entries(EVENT_LIMITS)) {
    for (const group of hooks[event]) assert.equal(group.hooks[0].timeout, limit, `${event} timeout in hooks.json (${group.matcher ?? 'all'})`);
    assert.ok(effectiveTimeout({ timeout: 600 }, event) < limit);
  }
  assert.equal(effectiveTimeout({ timeout: 10 }, 'PreToolUse'), 10);
});

test('entries that could never run are named', () => {
  assert.match(hookProblems({ events: { SubagentStop: '' } })[0], /not an event first-pass runs hooks on/);
  assert.match(hookProblems({ scope: 'files', events: { UserPromptSubmit: '' } })[0], /files-scope hook never runs/);
  assert.deepEqual(hookProblems({ scope: 'session', events: { UserPromptSubmit: '', PreToolUse: 'Edit' } }), []);
});

test('a SessionStart matcher is matched against how the session started', () => {
  const ws = { root: '/w', repos: [{ name: 'api', abs: path.resolve('/w/api') }], hooks: [{ id: 'h', scope: 'session', from: 'api', repos: ['api'], events: { SessionStart: 'compact' } }] };
  assert.equal(selectRuns('SessionStart', { source: 'startup' }, ws, () => []).length, 0);
  assert.equal(selectRuns('SessionStart', { source: 'compact' }, ws, () => []).length, 1);
});

test('a session hook copied into several repos is left to Claude Code in a session started inside any of them', () => {
  const repos = ['api', 'mobile', 'web'].map((name) => ({ name, abs: path.resolve('/w', name) }));
  const ws = { root: path.resolve('/w'), repos, hooks: [{ id: 'guard', scope: 'session', from: 'api', sameAs: ['mobile'], repos: ['api'], events: { UserPromptSubmit: '' } }] };
  const runs = (start) => selectRuns('UserPromptSubmit', { prompt: 'x' }, ws, () => [], start).length;
  assert.equal(runs(null), 1, 'from the main folder');
  assert.equal(runs(repos[0]), 0, 'inside api');
  assert.equal(runs(repos[1]), 0, 'inside mobile, which holds the same copy');
  assert.equal(runs(repos[2]), 1, 'inside web, which has no copy');
});

test('PreToolUse: the deprecated top-level "block" still denies, and exit 2 keeps the JSON reason', () => {
  const legacy = merge('PreToolUse', [{ status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'ticket mode' }) }]);
  assert.equal(legacy.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(legacy.hookSpecificOutput.permissionDecisionReason, 'ticket mode');
  const approve = merge('PreToolUse', [{ status: 0, stdout: JSON.stringify({ decision: 'approve' }) }]);
  assert.equal(approve.hookSpecificOutput.permissionDecision, 'allow');
  const both = merge('PreToolUse', [
    { status: 2, stderr: 'generic', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'the real reason' } }) },
  ]);
  assert.equal(both.hookSpecificOutput.permissionDecisionReason, 'the real reason');
});

test('terminal notifications pass through, and JSON lines are read the way Claude Code reads them', () => {
  assert.equal(merge('Stop', [{ status: 0, stdout: JSON.stringify({ terminalSequence: '\u0007' }) }]).terminalSequence, '\u0007');
  assert.equal(merge('UserPromptSubmit', [{ status: 0, stdout: '{}\n{}' }]).hookSpecificOutput.additionalContext, '{}\n{}');
  assert.match(merge('UserPromptSubmit', [{ name: 'x', status: 0, stdout: '{"a":1}\n{"b":2}' }]).systemMessage, /x printed invalid JSON/);
});

test("merged context stays under Claude Code's cap, with first-pass's own notices first and whole", () => {
  const big = (label) => ({ label, status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x'.repeat(6000) } }) });
  const own = { own: true, json: { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'first-pass done check: ...' } } };
  const text = merge('Stop', [big('a'), big('b'), own]).hookSpecificOutput.additionalContext;
  assert.ok(text.length <= CONTEXT_CAP, `length ${text.length}`);
  assert.ok(text.startsWith('first-pass done check'));
  assert.match(text, /first-pass trimmed \d+ characters/);
});

test('done check: honest reports and descriptions of behaviour are not claims', () => {
  const edits = [{ prompt: 'p1', file: '/w/api/src/a.ts', rel: 'api/src/a.ts' }];
  for (const message of [
    'Added a guard for the working tree state. Not verified: the e2e run.',
    'The retry path is written, but nothing is verified.',
    'Here is how the retry works now.',
    'Fixed the retry in the claim path.\nNot verified: the flow test, it needs the database.',
  ]) {
    assert.equal(doneCheck({ prompt_id: 'p1', last_assistant_message: message }, edits), null, message);
  }
});

test('an approval pins the whole folder of the script, quoted paths with spaces and relative paths included', () => {
  const root = tempDir();
  const repo = path.join(root, 'api');
  const hooksDir = path.join(repo, '.claude', 'my hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'guard.js'), "require('./helper.js')");
  fs.writeFileSync(path.join(hooksDir, 'helper.js'), 'module.exports = 1');
  const quoted = { id: 'g', scope: 'session', from: 'api', events: { PreToolUse: 'Edit' }, command: 'node "${CLAUDE_PROJECT_DIR}/.claude/my hooks/guard.js"' };
  quoted.approved = approval(quoted, [repo], root);
  assert.deepEqual(Object.keys(quoted.approved.files).sort(), ['api/.claude/my hooks/guard.js', 'api/.claude/my hooks/helper.js']);

  fs.writeFileSync(path.join(hooksDir, 'helper.js'), 'module.exports = 2');
  assert.match(whyPaused(quoted, repo, root), /helper\.js changed since it was approved/);
  fs.writeFileSync(path.join(hooksDir, 'helper.js'), 'module.exports = 1');
  assert.equal(whyPaused(quoted, repo, root), null);
  fs.rmSync(path.join(hooksDir, 'helper.js'));
  assert.match(whyPaused(quoted, repo, root), /helper\.js was removed since it was approved/);

  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.writeFileSync(path.join(repo, 'scripts', 'lint.sh'), 'echo ok');
  const relativeHook = { id: 'r', events: { PostToolUse: 'Edit' }, command: 'sh scripts/lint.sh', scope: 'files' };
  assert.deepEqual(Object.keys(approval(relativeHook, [repo], root).files), ['api/scripts/lint.sh']);
});

test('a hook that leaves a background process behind still answers on time', async () => {
  const root = tempDir();
  const ws = { root, repos: [], hooks: [] };
  const repo = { name: 'api', abs: root };
  const hook = { id: 'bg', scope: 'session', from: 'api', events: { PostToolUse: '' }, command: 'sleep 4 & echo "{}"', timeout: 20, approved: undefined };
  hook.approved = approval(hook, [root], root);
  const started = Date.now();
  const result = await runHook({ hook, repo, cwd: root }, { hook_event_name: 'PostToolUse' }, ws, 'PostToolUse');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.stdout.trim(), '{}');
});

test('a command Node refuses to start is reported, not thrown', { skip: process.platform !== 'win32' }, async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'x.cmd'), '@echo {}');
  const hook = { id: 'cmd', scope: 'session', from: 'api', events: { PreToolUse: '' }, command: path.join(root, 'x.cmd'), args: [] };
  hook.approved = approval(hook, [root], root);
  const result = await runHook({ hook, repo: { name: 'api', abs: root }, cwd: root }, { hook_event_name: 'PreToolUse' }, { root, repos: [], hooks: [] }, 'PreToolUse');
  assert.equal(result.status, 127);
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.3.1', '0.3.0'), 1);
});
