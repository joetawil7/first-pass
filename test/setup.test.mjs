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

test('the work goes on while a review runs, but nothing is committed or called done before its result', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\s+/g, ' ');
  for (const file of ['skills/setup-first-pass/assets/rules-block.md', 'skills/ship-check/SKILL.md']) {
    const text = read(file);
    assert.match(text, /in the background/, `${file}: a review runs in the background`);
    assert.match(text, /reads or runs but does not edit the files under review/, `${file}: nothing edits what the reviewer reads`);
    assert.match(text, /Edits wait for the review/, `${file}: edits wait for the review`);
    assert.match(text, /Only runs the repo's test limits allow beside the review go at the same time/, `${file}: only runs the test limits allow`);
    assert.match(text, /which ports, databases and suites the session will use while it runs/, `${file}: the reviewer is told what will be in use`);
    assert.match(text, /Edits wait for the review \(a fix found meanwhile joins its fixes\), so the reviewer never reads a tree that is changing/, `${file}: edits wait, no exceptions`);
    assert.match(text, /Until the review's result is in and handled, every reply says built, not done, and what it waits on; nothing of the change is committed to the user's branch, pushed or merged, unless the user says to ship it as it is .{0,70}; and either way it is not called done/, `${file}: shipping as it is never makes unreviewed work "done"`);
    assert.doesNotMatch(text, /called done,? unless the user says to ship it/, `${file}: "ship it as it is" never covers "done"`);
    assert.match(text, /Any edit CI's clean checkout does not hold \(a review-led fix, a fix the user picked, or one a check led to\) is copied into it once any run there has finished or been stopped, and reruns only the checks it can affect: the tests of the files it changed, the unit, integration and end-to-end \(browser\) test files that reach them \(directly or through their callers\), the part that failed when a check led to it, and the format, lint, type and build checks of the packages it touched\. A part it reaches through shared code runs whole only when the edit changes what that other code sees \(a shared package's exports, a migration, a config value, a route's or event's shape\)\. A run that selects no tests is not a pass: fix the selection, or run that part whole/, `${file}: an edit waits for a running check, reruns what reaches the changed code and the part that failed, and an empty selection is fixed or run whole`);
    assert.match(text, /The words, monitoring and invariants checks run for what it changed/, `${file}: the words, monitoring and invariants checks still run after each edit`);
    assert.match(text, /CI's full checks (\(step 4\) )?run once more, in the clean checkout holding the final change, unless every part of them has already run whole, from start to end, after the final change was copied in, once no review or fix is pending and nothing is left for the user to pick or answer, the user picks nothing more from a list, or the user asks to call it done, commit, push or ship; a report that ends with a list or a question (\(step 8\) )?goes out with them still to run, and says how long they take/, `${file}: the full checks rerun unless every part ran to its end on the final change, once nothing is pending, left to pick or answer, or the user asks to finish`);
    assert.match(text, /Nothing is called done before they pass \(failures the base has too are named\), and nothing is committed, pushed or shipped before them unless the user says to ship it as it is; a later edit with no logic in it needs only what ("Scale it to the change"|step 0) says/, `${file}: done and ship wait for the full checks, ship it as it is still works, and a no-logic edit after them stays small`);
    assert.match(text, /Until they pass, write "full checks still to run" in the task list, and every report says built, not done, and which checks ran on the latest edit/, `${file}: the wait is written down and every report says what ran`);
    assert.match(text, /A later edit reruns only the checks it can affect, and the full checks run once more on the final change/, `${file}: several items rerun only what an edit affects`);
    assert.doesNotMatch(text, /again after any later edit|sized to the whole change as/, `${file}: no full rerun after every edit`);
    assert.doesNotMatch(text, /if their last run did not hold the final change|if an edit came after their last run|run to its end while it held/, `${file}: the final run is decided by every part having run on the final change, not by the last run`);
    assert.doesNotMatch(text, /while (it|they|the reviews?) runs?[^.]*\b(build|commit)/i, `${file}: nothing is built or committed while a review runs`);
    assert.doesNotMatch(text, /no need to tell the reviewer|reviewer is not told/i, `${file}: the reviewer is always told what is in use`);
  }
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), /ports, databases or suites the author is using meanwhile, leave them alone/);
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), /The `review` skill waits for its reviewers, as it says/, 'the rules leave the review skill waiting for its reviewers');
  assert.match(read('skills/ship-check/SKILL.md'), /a confirmed finding you list rather than fix that breaks an invariant goes into its Known breaks/, 'listed invariant breaks are recorded');
  assert.doesNotMatch(read('README.md'), /called done[^.]*unless you say to ship it/, 'README never lets shipping as it is make work done');
  assert.match(read('README.md'), /A later fix reruns only the checks it can affect, and the full checks run once more on the final change: nothing is committed before them unless you say to ship it as it is, and nothing is called done before they pass/, 'the README says the full checks run once at the end');
  assert.match(read('skills/ship-check/SKILL.md'), /Full checks on the final change: <passed, with counts \(failures the base has too named\) \| still to run: which checks ran on the latest edit, and how long the full checks take>/, 'the report says whether the final full checks ran, base failures and time included');
  assert.match(read('skills/ship-check/SKILL.md'), /Keep the worktree until those final full checks pass/, 'the clean checkout stays until the final full checks pass');
});

test('a question waits until nothing else can move, and no work is built on a guess at its answer', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\s+/g, ' ');
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /\*\*Ask when nothing else can move\.\*\* A question stops the session until the user answers/, 'the rule says why a question costs time');
  assert.match(rules, /Mid-work, first do every part that does not depend on the answer \(other items, reads, checks, a draft of the report\), then ask everything still open in one set, each question with the pick you recommend/, 'independent work first, then one set with recommendations');
  assert.match(rules, /Work that depends on the answer waits for it, never built on a guess/, 'nothing is built on an answer not given');
  assert.match(rules, /A decision that blocks nothing waits for the end report/, 'a decision that blocks nothing goes to the end');
  assert.match(rules, /A skill that asks before the work starts, as `sharpen` does, still asks there/, 'sharpen still stops before it starts');
  assert.match(rules, /Live money, production deletes and outward-facing actions still need a yes/, 'a yes before money, deletes and outward actions is still needed');
  assert.match(read('skills/sharpen/SKILL.md'), /start nothing until the user answers/, 'sharpen still starts nothing until its questions are answered');
  assert.match(read('README.md'), /Questions to you wait until nothing else can move/, 'the README says it');
  assert.match(rules, /It never delays a stop: a failed action in a chain \(any "One step at a time" names\), or being stuck, stops the work and is said at once, as that rule and "Stuck is not a licence" say/, 'a failed action in a chain, or being stuck, still stops everything at once');
  assert.match(rules, /A failing test or CI check on the change is not such a stop: it is fixed, or named when the base fails it too\. A check that shows a chained action failed \(a deploy's logs\) is such a stop/, 'a failing test on the change is fixed or named, but a check showing a deploy or other chained action failed still stops');
  assert.doesNotMatch(rules, /A failing check is not such a stop/, 'no unscoped "a failing check is not a stop"');
  assert.match(rules, /A write that failed or timed out may still have happened: say so, and check before any retry; never retry it blind/, 'a failed or timed-out outside write is checked before any retry, even one the user asks for');
  assert.match(rules, /Chained actions \(commit, push, merge, deploy, migrate, publish, and any other write outside this machine: a vendor or API write, an email or message sent\): check each before the next .{0,40}and stop at the first failure/, 'a failed send or vendor write stops the chain too, so it is never retried blind');
  assert.match(rules, /Write each question you hold back in one line when it comes up \(in the task list, starting one if there is none\), so it survives a compacted context/, 'every held-back question is written down, at any stage, in a list started for it if need be');
  assert.doesNotMatch(rules, /Mid-work, write each/, 'the write-down is not limited to mid-work');
  assert.match(rules, /A decision that blocks nothing waits for the end report; a pre-mortem's "Not handled, because" lines do not: they are asked before the build they shape/, 'a pre-mortem gap is put to the user before the build');
  assert.match(read('skills/premortem/SKILL.md'), /Every "Not handled, because" is asked of the owner, to accept or reject, before building what it shapes: not buried in the plan, and not held for the end report/, 'the premortem skill says asked, as the rules do');
  assert.doesNotMatch(read('skills/premortem/SKILL.md'), /is shown to the owner before building/, 'the premortem skill no longer says only shown');
  assert.match(read('README.md'), /Questions to you wait until nothing else can move \(`sharpen` and setup still ask before they start, and a failed commit, push or deploy still stops the work at once\)/, 'the README keeps the exceptions');
  assert.doesNotMatch(read('README.md'), /a failed step still stops/, 'a failed check is fixed, not a reason to stop');
  assert.match(read('skills/setup-first-pass/assets/profile-block.md'), /none left open at the end of a turn, except the task's scope, harm waiting in a batch or for the user's answer, full checks still to run, and a question that still matters and the user has not answered yet, asked or not/, 'the profile keeps the scope, batched harm, the final full checks and open questions across turns');
});

test('work stays inside the task scope, and only hulk lifts it', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\s+/g, ' ');
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /\*\*Stay in the task's scope\.\*\* Before the first edit, or the first finding in a review or an audit, draw the task's scope as the `premortem` skill's step 0 says, and write it in a few lines, in the plan and in the task list so it survives a compacted context/, 'the scope is written first, where a compaction cannot lose it');
  assert.match(rules, /Inside: the code the change touches; everything that reads or writes the same data or calls the same code \(the pre-mortem's neighbors, wherever they live\); the rest of the same feature's flow/, 'neighbors stay inside the scope, so their checks are kept');
  assert.match(rules, /the steps that handle what it creates or uses in the paths that end it \(every ending the pre-mortem's question 6 names, the account's deletion included\); every pair the repo's section lists as the same job in two places, when the change touches either side or does that job; every sentence that describes it; and any problem the change caused or made worse, wherever it lives/, 'every ending, same-job pairs, words and harm the change made worse are inside');
  assert.match(rules, /Outside: other features, and the other steps of shared paths, even in the same files or modules/, 'other features and the other steps of shared paths are outside');
  assert.match(rules, /A fix the user picks from the task's end list keeps this scope/, 'a picked fix does not widen the scope');
  assert.match(rules, /then a search for the same pattern in the task's scope/, 'the bug rule searches the scope');
  assert.doesNotMatch(rules, /Autopilot/, 'the public rules use neutral examples');
  assert.match(rules, /words like "check everything" or "cover all cases" ask for full checks inside the scope, never a wider one/, 'habit words never widen the scope');
  assert.match(rules, /A problem outside is neither fixed, chased nor offered as a next step; one seen in passing that does real harm gets one line in the report, marked "outside this task"/, 'nothing outside is fixed, chased or offered, and real harm still gets a line');
  assert.match(rules, /The `hulk` skill, typed by the user, lifts the scope for one task/, 'hulk lifts it');
  const breaker = read('skills/setup-first-pass/assets/breaker.md');
  assert.match(breaker, /Every other reader and writer of what the diff touches is inside the scope, wherever it lives/, 'the reviewer keeps hunting neighbors');
  assert.match(breaker, /the steps that handle what the change creates or uses in the paths that end it \(every ending the Endings question below names, the account's deletion included\); every pair the repo's section lists as the same job in two places, when the change touches either side or does that job; every sentence that describes it; and any problem the change caused or made worse, wherever it lives/, 'the reviewer keeps every ending, pairs, words and harm the change made worse inside');
  assert.match(breaker, /A problem you see outside in passing is never a finding/, 'the reviewer reports nothing outside as a finding');
  assert.match(breaker, /when the brief says the scope is lifted \(`hulk`\), look across the whole codebase and every repo that shares its code, data or vendors/, 'the reviewer looks across related repos under hulk, as hulk says');
  const fix = read('skills/fix-the-class/SKILL.md');
  assert.match(fix, /Search the task's scope for other instances/, 'the class search stays in the scope');
  assert.match(fix, /When the user's own prompt asks for this bug's fix, or the user lifted the scope with `hulk`, the scope is the whole codebase/, 'a bug the user asked to fix keeps its codebase-wide search');
  assert.match(fix, /A fix the user picks from a task's end list is not such a prompt: it keeps that task's scope/, 'a fix picked from a task list stays in that task');
  assert.doesNotMatch(fix, /Search the whole codebase for other instances/, 'no unscoped class search');
  assert.match(read('skills/premortem/SKILL.md'), /Scope: <goal>\. Inside: <features, flows and modules>\. Endings: <the step-6 ending steps that handle what it creates or uses, or "none, because ___">\. Outside: <nearest left out, each with why the goal holds without it>\. \(Or "lifted \(hulk\)"\.\)/, 'the pre-mortem writes the scope, endings included');
  const ship = read('skills/ship-check/SKILL.md');
  assert.match(ship, /the pre-mortem, and the task's scope \(or that the user lifted it with `hulk`\)/, 'ship-check gives the reviewer the scope');
  assert.match(ship, /\*\*Outside the task's scope\*\* \(the rules' "Stay in the task's scope"\): not a finding/, 'ship-check sorts outside problems out of the findings');
  assert.doesNotMatch(ship, /\*\*Out of scope\*\*/, 'older findings are called older, not out of scope');
  assert.match(ship, /A problem the change caused or made worse is never outside, wherever it lives/, 'harm the change made worse is never sorted outside');
  assert.match(read('skills/premortem/SKILL.md'), /Inside it by definition: the neighbors in step 5, the steps of the ending paths in step 6 that handle what the change creates or uses, the same job done in two places, the sentences in step 9, and any problem the change caused or made worse/, 'the pre-mortem keeps its questions inside the scope');
  const hulk = read('skills/hulk/SKILL.md');
  assert.match(hulk, /^--- name: hulk /, 'the hulk skill exists');
  assert.match(hulk, /disable-model-invocation: true/, 'only the user starts hulk');
  assert.match(hulk, /\*\*Everything else in the rules still holds\*\*: a yes before money, production or anything outward-facing/, 'hulk never lifts the yes rules');
  assert.doesNotMatch(read('README.md'), /The reviewer still reports everything\./, 'the README no longer says the reviewer reports everything');
  assert.match(read('README.md'), /This is version 0\.6,/, 'the README names the version');
  assert.match(breaker, /Other features, and the other steps of shared paths, are not, even in the same files/, 'the reviewer leaves other steps of a shared path outside');
  assert.match(read('README.md'), /anything the change itself breaks counts as inside, wherever it is/, 'the README keeps harm the change caused inside');
  assert.match(read('README.md'), /finds the same pattern in the task's scope, and adds the check/, 'the README bug bullet matches the scope');
  assert.match(read('README.md'), /\(everywhere when your own prompt asks for that fix, not when you pick it from a task's list\)/, 'the README table row keeps a picked fix in its task');
  assert.match(fix, /the whole codebase when the user's own prompt asks for the fix, not when it is picked from a task's list/, 'the skill summary every session loads keeps a picked fix in its task');
  const pm = read('skills/premortem/SKILL.md');
  assert.match(pm, /Anything else draws it from the code, not from the prompt's words alone/, 'the scope is drawn from the code');
  assert.match(pm, /Find where that feature lives: search the repo for the user's words and the feature's own names/, 'the scope starts at the feature itself');
  assert.match(pm, /the feature's other paths \(by hand and on a schedule, one at a time and in bulk\)/, 'the scheduled and bulk paths of the same feature are inside');
  assert.match(pm, /\(every ending in step 6: cancel, refund, delete, disconnect, reconnect, expire, downgrade, a plan lapsed, a trial ending, replace, and the deletion of the whole account\)/, 'every ending, account deletion included, is named when drawing the scope (a live run missed account deletion twice)');
  assert.match(pm, /Endings: <the steps of each step-6 ending \(account deletion included\) that handle what it creates or uses, or "none, because ___">\. Outside: <the nearest features left out, by name, each with why the goal still holds without it>\.` Naming the endings and the nearest ones left out makes each border a decision, not an accident: one whose "why" fails goes inside/, 'the scope has a required endings slot, and each outside feature says why the goal holds without it');
  assert.match(pm, /Draw it again when the work finds something new it depends on/, 'the scope is redrawn when the work needs more');
  assert.match(rules, /From the second review on, real harm only an unusual path meets \(a rare order of steps, a race, an error at the wrong moment: the reviewer's "unusual"\) is collected instead, written in the task list when it is found so a compacted context cannot lose it, and fixed in one batch once the item's other fixes are reviewed, each with its own failing-first test; the batch gets one review\. Rare-path harm that review, or any later review of the same item, finds starts no new round: it is written in the task list and goes first on the end list as real harm; nothing of the item ships until the user answers it, and while it stays unfixed the item is built, not done\. Harm met in normal use is still fixed as it is found/, 'rare-path harm after the first review gets one batch and one review, then goes to the user instead of another round');
  assert.match(ship, /From the second review on, real harm whose Who meets it is `unusual` waits instead: collect it, fix it in one batch once the item's other fixes are reviewed/, 'ship-check batches rare-path harm the same way');
  assert.match(rules, /\(and a Known breaks line in that repo's `INVARIANTS\.md` when it breaks one\)/, 'outside harm that breaks an invariant is recorded');
  assert.match(fix, /and a Known breaks line in that repo's `INVARIANTS\.md` when it breaks one; nothing else is edited for it/, 'fix-the-class records an outside break');
  assert.match(hulk, /a review already running is started again with the scope lifted/, 'hulk re-runs a review started with a scope');
  assert.match(read('README.md'), /\(measured before 0\.6's scope rule\)/, 'the README dates its reviewer result');
  assert.match(rules, /is collected instead, written in the task list when it is found so a compacted context cannot lose it/, 'batched harm is written down where a compaction cannot lose it');
  assert.match(rules, /except that a bug fix the user's own prompt asks for searches the whole codebase for its pattern, as `fix-the-class` says/, 'the rules carry fix-the-class exception');
  assert.match(pm, /A change with no logic in it \(a comment, a doc, a spelling fix: no behaviour changes and no label's meaning changes; when unsure, it is not one\) writes one line, `Scope: <the file or text>, no behaviour change`, and goes on/, 'a copy tweak writes a one-line scope');
  assert.match(read('README.md'), /gets one line in the report \(and one in that repo's list of known breaks when it breaks one of its rules\), and nothing else/, 'the README matches the known-breaks line');
  assert.doesNotMatch(hulk, /as first-pass did before scopes/, 'hulk does not misdescribe the old behaviour');
  assert.match(ship, /give the batch one review\. Rare-path harm that review, or any later review of the same item, finds starts no new round: it goes first on the list \(step 8\) as real harm; nothing of the item ships until the user answers it, and while it stays unfixed the item is built, not done/, 'ship-check stops after one batch');
  assert.doesNotMatch(rules + ship, /any batch that review leads to/, 'no batch leads to another batch');
  assert.match(ship, /`fix now`: real harm \(the review named it, or Jev found it\): handle it as real harm above says \(at once; in the batch when its Who meets it is `unusual` and a later review found it; or first on the list when the batch's review or a later one found it\)/, 'the Jev verdict follows the batch rule');
  assert.match(hulk, /handled as they say \(fixed at once, fixed in their one batch when only a rare path meets it, or first on the end list when that batch's review or a later one finds it\)/, 'hulk follows the batch rule');
  assert.match(hulk, /`\/first-pass:review hulk <what to review>`/, 'hulk points to the review in hulk mode');
  assert.match(rules, /neither "Extra work is proposed" nor the report's "anything now inaccurate that was noticed" reaches outside the scope/, 'outside problems are not proposed or reported as untrue sentences');
  const review = read('skills/review/SKILL.md');
  assert.match(review, /A request that starts with `hulk` \(`\/first-pass:review hulk #123`\), or a task the user lifted with `\/first-pass:hulk`, lifts it/, 'the review skill has a hulk mode');
  assert.match(review, /Scope: <the change under review \| lifted \(hulk\)>/, 'the review header shows the scope');
  assert.match(review, /whether it may run the change's code, and the scope from step 1 \(or that it is lifted\)/, 'the review skill gives its reviewer the scope');
  assert.match(review, /Outside this task: <real harm seen outside the scope, one line each with file:line, or "none"; left out when the scope is lifted>/, 'the review report has an outside-this-task line');
  assert.match(read('README.md'), /`\/first-pass:review hulk <what>` reviews with the scope lifted/, 'the README names the review hulk mode');
  assert.match(ship, /Write each finding that waits in the batch, or for the user's answer, in the task list when it is found/, 'harm left for the user is written down too');
  assert.match(ship, /To pick: <real harm left for the user's answer first, then the smaller and older findings/, 'the end list asks about harm left for the user first');
  assert.match(rules, /6\. \*\*Endings\.\*\* Cancel, delete, disconnect, reconnect, expire, downgrade, plan lapsed, trial end, replace\./, 'the rules list every ending');
  assert.match(breaker, /\*\*Endings\*\*: cancel, delete, disconnect, reconnect, expire, downgrade, plan lapsed, trial end, replace\./, 'the reviewer lists every ending');
  assert.match(read('README.md'), /those only a rare path reaches, found after the first review, are collected and fixed together in one batch with one review, and a rare one that batch's review or a later review of the same change finds comes to you first on the list instead of starting another round; nothing ships until you answer, and the change stays not done while it's unfixed/, 'the README describes the rare-path batch');
  assert.match(read('.github/workflows/validate.yml'), /habit-words sharpen review jev hulk; do/, 'CI checks the hulk skill exists');
  assert.match(read('README.md'), /`\/first-pass:hulk` lifts the scope for one task/, 'the README says it');
});
