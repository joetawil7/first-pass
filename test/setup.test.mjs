// The setup helpers and the start-of-session check, against throwaway folders.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandTarget, hookProblems } from '../scripts/lib/bridge.mjs';
import { syncCursorRules, checkCursorRules } from '../scripts/lib/cursor-rules.mjs';
import { drift } from '../scripts/lib/drift.mjs';
import { loadProblems } from '../scripts/lib/instructions.mjs';
import { findRepos } from '../scripts/lib/repos.mjs';
import { surveyWorkspace } from '../scripts/lib/survey.mjs';
import { loadWorkspace } from '../scripts/lib/workspace.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs');
// The start-of-session check reads the user's own Claude Code folder; the tests get an empty one.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-config-'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-setup-'));
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
}
function cli(...args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('repos are found two levels down and through links, never in dot-folders; survey and the check agree', () => {
  const root = tempDir();
  gitRepo(path.join(root, 'api'));
  gitRepo(path.join(root, 'clients', 'web'));
  gitRepo(path.join(root, '.hidden'));
  gitRepo(path.join(root, 'api', 'nested-inside-a-repo'));
  const elsewhere = tempDir();
  gitRepo(path.join(elsewhere, 'linked'));
  fs.symlinkSync(path.join(elsewhere, 'linked'), path.join(root, 'linked'), 'junction');

  const found = findRepos(root).map((dir) => path.relative(root, dir).replace(/\\/g, '/')).sort();
  assert.deepEqual(found, ['api', 'clients/web', 'linked']);
  assert.deepEqual(surveyWorkspace(root).repos.map((r) => r.name).sort(), ['api', 'clients/web', 'linked']);
  assert.match(drift(null, { cwd: root }, '0.2.0')[0], /holds 3 git repos/);
});

test('instruction files Claude Code will not load are named', () => {
  const repo = tempDir();
  write(path.join(repo, 'AGENTS.md'), 'rules');
  assert.match(loadProblems(repo)[0], /no CLAUDE\.md/);
  write(path.join(repo, 'CLAUDE.md'), '@INVARIANTS.md\n');
  assert.match(loadProblems(repo)[0], /does not import AGENTS\.md/);
  write(path.join(repo, 'CLAUDE.md'), '@./AGENTS.md\n@INVARIANTS.md\n');
  assert.deepEqual(loadProblems(repo), []);

  // CLAUDE.md hard-linked to AGENTS.md is one file: it loads, and the survey says so.
  const main = tempDir();
  const linked = path.join(main, 'site');
  gitRepo(linked);
  write(path.join(linked, 'AGENTS.md'), 'rules');
  fs.linkSync(path.join(linked, 'AGENTS.md'), path.join(linked, 'CLAUDE.md'));
  assert.deepEqual(loadProblems(linked), []);
  assert.equal(surveyWorkspace(main).repos.find((r) => r.name === 'site').claudeMdIsAgentsMd, true);

  // A plugin's own repo keeps its rules in AGENTS.md on purpose: a root CLAUDE.md fails strict validation.
  const plugin = tempDir();
  write(path.join(plugin, 'AGENTS.md'), 'rules');
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
  assert.deepEqual(loadProblems(plugin), []);
});

test('a shell command reaches a repo through git -C or a leading cd', () => {
  const cwd = path.resolve('/w');
  assert.equal(commandTarget({ cwd, tool_input: { command: 'git -C api push --force' } }), path.resolve('/w/api'));
  assert.equal(commandTarget({ cwd, tool_input: { command: 'cd "web app" && npm test' } }), path.resolve('/w/web app'));
  assert.equal(commandTarget({ cwd, tool_input: { command: 'Set-Location web; npm test' } }), path.resolve('/w/web'));
  assert.equal(commandTarget({ cwd, tool_input: { command: 'npm test' } }), null);
  assert.equal(commandTarget({ cwd, tool_input: { file_path: 'x' } }), null);
});

test('workspace.json entries that cannot work are refused', () => {
  assert.match(hookProblems({ events: { PostToolUse: 'Edit' }, async: true })[0], /async/);
  const root = tempDir();
  write(path.join(root, '.first-pass', 'workspace.json'), JSON.stringify({ firstPass: 1, repos: [{ name: 'a', path: 'a' }], hooks: [{ id: 'x', scope: 'files', events: { PostToolUse: '' }, command: 'true' }] }));
  assert.throws(() => loadWorkspace(root), /files hook x needs "repos" or "from"/);
});

test('record keeps a changed CI hash until the repo is named, and notices changed repo hooks', () => {
  const root = tempDir();
  const repo = path.join(root, 'api');
  gitRepo(repo);
  write(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: npm test\n');
  write(path.join(root, '.first-pass', 'workspace.json'), JSON.stringify({ firstPass: 1, repos: [{ name: 'api', path: 'api' }] }));
  assert.equal(cli('record', root).status, 0);

  write(path.join(repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  a:\n    steps:\n      - run: npm run test:all\n');
  const check = () => drift(loadWorkspace(root), { cwd: root }, '0.2.0').join('\n');
  assert.match(check(), /api's CI config changed/);
  const again = cli('record', root);
  assert.match(again.stdout, /api: CI changed since its section was written/);
  assert.match(check(), /api's CI config changed/, 'a plain re-run does not hide it');
  cli('record', root, '--ci', 'api');
  assert.doesNotMatch(check(), /CI config changed/);

  write(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }] } }));
  assert.match(check(), /api's own Claude Code hooks changed since setup/);
});

test('an approval records the commit it was made at', () => {
  const root = tempDir();
  const repo = path.join(root, 'api');
  gitRepo(repo);
  write(path.join(repo, '.claude', 'hooks', 'g.js'), '');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x']);
  write(
    path.join(root, '.first-pass', 'workspace.json'),
    JSON.stringify({ firstPass: 1, repos: [{ name: 'api', path: 'api' }], hooks: [{ id: 'g', scope: 'session', from: 'api', events: { PreToolUse: 'Edit' }, command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/g.js"', approve: true }] }),
  );
  assert.equal(cli('record', root).status, 0);
  const hook = JSON.parse(fs.readFileSync(path.join(root, '.first-pass', 'workspace.json'), 'utf8')).hooks[0];
  assert.match(hook.approved.commits.api, /^[0-9a-f]{40}$/);
});

test('an .mdc import written with ./ is synced like any other', () => {
  const repo = tempDir();
  write(path.join(repo, '.cursor', 'rules', 'x.mdc'), '---\nalwaysApply: true\n---\nRule X\n');
  write(path.join(repo, 'CLAUDE.md'), '@./.cursor/rules/x.mdc\n');
  assert.equal(syncCursorRules(repo).length, 2);
  assert.deepEqual(checkCursorRules(repo), []);
});

test('in one repo, the start-of-session check still reports a stale Cursor-rule copy', () => {
  const repo = tempDir();
  gitRepo(repo);
  write(path.join(repo, '.cursor', 'rules', 'x.mdc'), '---\nalwaysApply: true\n---\nRule X\n');
  write(path.join(repo, 'CLAUDE.md'), '@.claude/cursor-rules/x.md\n');
  write(path.join(repo, '.claude', 'cursor-rules', 'x.md'), 'Old rule\n');
  assert.match(drift(null, { cwd: repo }, '0.2.0').join('\n'), /out of date/);
});

test('a main folder that is a git repo and lists itself in its workspace file is not one of its repos', () => {
  const root = tempDir();
  gitRepo(root);
  gitRepo(path.join(root, 'api'));
  const outside = path.join(tempDir(), 'side');
  gitRepo(outside);
  write(path.join(root, 'w.code-workspace'), JSON.stringify({ folders: [{ path: '.' }, { path: outside }] }));
  assert.deepEqual(surveyWorkspace(root).repos.map((r) => r.name).sort(), ['api', 'side']);
});

test('a workspace file folder given as a uri is skipped with a note, not a crash', () => {
  const root = tempDir();
  write(path.join(root, 'w.code-workspace'), JSON.stringify({ folders: [{ uri: 'vscode-remote://x' }, { path: '.' }] }));
  const survey = surveyWorkspace(root);
  assert.match(survey.codeWorkspaceFolders.find((f) => f.problem).problem, /without a "path"/);
});

test('only real harm is fixed during the work, the rest goes on one list, and every place names the same harms', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\s+/g, ' ');
  const breaker = read('skills/setup-first-pass/assets/breaker.md');
  const high = /\*\*Severity\*\*: high \(([^)]+)\)/.exec(breaker)[1].split(/,\s*/);
  assert.ok(high.length >= 4, 'the breaker lists what it rates high');
  const worst = /\*\*Worst case\*\*(.*?)- \*\*Who meets it/.exec(breaker)[1];
  const { FIX_NOW, WHO } = await import('../scripts/lib/jev.mjs');
  // The breaker's worst-case words are the judge's options, so a label never falls between them.
  for (const kind of [...Object.keys(FIX_NOW), 'small']) assert.match(worst, new RegExp(`\\b${kind}\\b`), `the breaker offers "${kind}"`);
  const who = /\*\*Who meets it\*\*(.*?)- \*\*Scenario/.exec(breaker)[1];
  for (const kind of Object.keys(WHO)) assert.match(who, new RegExp(`\\b${kind}\\b`), `the breaker offers who "${kind}"`);
  const word = { 'data loss': 'data', security: 'security', legal: 'legal', twice: 'twice' };
  const described = { money: /money lost/, data: /lost or leaked data/, twice: /done twice, sent wrong or sent without the yes/, security: /security hole/, legal: /legal breach/, crash: /a crash/, stuck: /work left stuck/, task: /doing what it was for/ };
  for (const file of ['skills/setup-first-pass/assets/rules-block.md', 'skills/ship-check/SKILL.md']) {
    const text = read(file);
    const harm = /real harm \(([^)]+)\)/.exec(text);
    assert.ok(harm, `${file} says what real harm is`);
    for (const kind of high) assert.ok(harm[1].includes(word[kind] ?? kind), `${file}: real harm covers "${kind}"`);
    for (const [kind, re] of Object.entries(described)) assert.match(text, re, `${file}: fixes "${kind}" right away`);
    // What is fixed follows the harm, never the reviewer's label, and the round cap is gone.
    assert.doesNotMatch(text, /round 3|three rounds/, `${file}: no review-round cap is left`);
    assert.match(text, /on one list|put it on the item's list/, `${file}: smaller findings go on one list`);
    assert.match(text, /once, at the end/, `${file}: the list reaches the user once`);
    assert.match(text, /one review together/, `${file}: the picked fixes share one review`);
    assert.match(text, /never clear/, `${file}: the judge can never clear harm`);
  }
  // The words step and the bug-fix skill must not pull small findings back into the work.
  const words = /## 6\. Words(.*?)## 7\./.exec(read('skills/ship-check/SKILL.md'))[1];
  assert.match(words, /untrue only in some state.*goes on the item's list/, 'ship-check step 6 lists a sentence untrue only in some state');
  const fixClass = /^---(.*?)---/.exec(read('skills/fix-the-class/SKILL.md'))[1];
  assert.match(fixClass, /review finding that does real harm/, 'fix-the-class is for review findings that do real harm');
  // Every judge command names its repo (the key is chosen by it), and a harm found by Jev or the
  // agent is carried into the later questions, so it is never advised away or lightly proven.
  const shipCheck = read('skills/ship-check/SKILL.md');
  const asks = shipCheck.match(/jev ask \w+[^`]*/g);
  assert.ok(asks.length >= 3, 'ship-check shows the harm, priority and proof commands');
  for (const ask of asks) assert.match(ask, /<file> <repo>$/, `"${ask}" names the file and the repo`);
  assert.match(shipCheck, /carries that harm as its `worst_case`/, 'ship-check carries a found harm into priority and proof');
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), /real harm it caused or made worse still open is built, not done/, 'only harm the change caused keeps it from done');
});
