// The habit-words reader and the reminder, against throwaway session folders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORDS_DUE_AFTER, drift, wordsDue } from '../scripts/lib/drift.mjs';
import { countMatching, readRecent, redact } from '../scripts/lib/words.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs');

function tempDir(name = 'first-pass-words-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

let clock = Date.parse('2026-09-20T10:00:00Z');
function at() {
  clock += 60_000;
  return new Date(clock).toISOString();
}
let ids = 0;
const human = (text, extra = {}) => ({ type: 'user', uuid: `u${++ids}`, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const reply = (text) => ({ type: 'assistant', uuid: `a${++ids}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });

function session(configDir, project, id, rows, mtime) {
  const dir = path.join(configDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

test('only what the user typed is kept: queued prompts in, tool output, notifications, commands and script turns out', async () => {
  const config = tempDir();
  const copied = human('Fix the login page and be 100% sure it works');
  session(config, 'p', 's1', [
    human('<ide_opened_file>The user opened a.ts</ide_opened_file>Dont assume, do a full review<system-reminder>rules</system-reminder>'),
    human([{ type: 'text', text: 'Check this <pasted_content id="x1">a long answer from another model</pasted_content id="x1"> please' }]),
    { type: 'user', uuid: 'n1', origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } },
    { type: 'user', uuid: 't1', turnOrigin: 'sdk', message: { content: 'Read package.json and quote it' } },
    { type: 'user', uuid: 'm1', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } },
    { type: 'user', uuid: 'c1', isCompactSummary: true, message: { content: 'This session is being continued' } },
    { type: 'user', uuid: 'r1', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'be 100% sure' }] } },
    { type: 'user', uuid: 'x1', message: { content: '<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>' } },
    { type: 'user', uuid: 'x2', message: { content: '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>' } },
    { type: 'user', uuid: 'x3', message: { content: '<command-name>/loop</command-name><command-message>loop</command-message><command-args>check the deploy every hour</command-args>' } },
    { type: 'user', uuid: 'i1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: 'old1', timestamp: at(), message: { content: 'A prompt from before origins were recorded' } },
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', origin: { kind: 'human' }, source_uuid: 'q-src', prompt: 'First 15 seconds I meant', timestamp: at() } },
    { type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>' } },
    { type: 'attachment', uuid: 'e1', attachment: { type: 'environment' } },
    copied,
    copied,
    'not json',
  ]);
  const result = await readRecent(path.join(config, 'projects'), 20);
  const texts = result.sessions[0].prompts.map((p) => p.text);
  assert.deepEqual(texts, [
    'Dont assume, do a full review',
    'Check this [pasted text left out] please',
    'check the deploy every hour',
    'A prompt from before origins were recorded',
    'First 15 seconds I meant',
    'Fix the login page and be 100% sure it works',
  ]);
  assert.equal(result.left['turns a script started'], 1);
  assert.equal(result.left['tool output'], 1);
  assert.equal(result.left['compaction summaries'], 1);
  assert.equal(result.left['skill and system text'], 1);
  assert.equal(result.left['commands and their output'], 2);
  assert.equal(result.left.interruptions, 1);
  assert.equal(result.left['notifications and messages from other sessions'], 2);
  assert.equal(result.left['repeated copies of a prompt'], 1);
  assert.equal(result.left['unreadable lines'], 1);
  assert.deepEqual(result.sessions[0].prompts[0].families.sort(), ['assume', 'full']);
});

test('pushback carries the end of the reply before it', async () => {
  const config = tempDir();
  session(config, 'p', 's1', [human('Be 100% sure'), reply('Fixed and verified: the totals are right.'), human('that doesnt make sense, reread your numbers')]);
  const [first, second] = (await readRecent(path.join(config, 'projects'), 20)).sessions[0].prompts;
  assert.equal(first.pushback, false);
  assert.equal(first.before, null);
  assert.equal(second.pushback, true);
  assert.equal(second.before, 'Fixed and verified: the totals are right.');
});

test('the newest sessions with typed prompts are read, script-only sessions and subagents skipped, a resumed copy counted once', async () => {
  const config = tempDir();
  const now = Date.now();
  const shared = human('Deploy it and make sure nothing breaks');
  session(config, 'a', 'old', [shared, human('older only')], now - 5000);
  session(config, 'b', 'resumed', [shared, human('newer')], now - 1000);
  session(config, 'c', 'script', [{ type: 'user', uuid: 's', turnOrigin: 'sdk', message: { content: 'automated' } }], now);
  const sub = path.join(config, 'projects', 'b', 'resumed', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), JSON.stringify(human('subagent text')) + '\n');

  const one = await readRecent(path.join(config, 'projects'), 1);
  assert.deepEqual(one.sessions.map((s) => s.id), ['resumed']);
  assert.equal(one.empty, 1);
  const both = await readRecent(path.join(config, 'projects'), 2);
  assert.deepEqual(both.sessions.map((s) => s.prompts.map((p) => p.text)), [['Deploy it and make sure nothing breaks', 'newer'], ['older only']]);
  assert.deepEqual(countMatching(both.sessions, (p) => /make sure/.test(p.text)), { prompts: 1, sessions: 1 });
});

test('secrets, contacts and credentials are replaced, ordinary words are not', () => {
  const cases = [
    ['Stripe key sk_test_FAKE0000example here', 'Stripe key [secret] here'],
    ['API key: Ab3Cd5Ef7Gh9', 'API key: [secret]'],
    ['App password for gmail: abcd efgh ijkl mnop', 'App password for gmail: [secret]'],
    ['Client Secret ID: 1234abcd', 'Client Secret ID: [secret]'],
    ['application identifier: Qz7Rt4Wm', 'application identifier: [secret]'],
    ['ACME_GH_TOKEN=abc123xyz', 'ACME_GH_TOKEN=[secret]'],
    ['the password is Hunter2!', 'the password is [secret]'],
    ['token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'token [secret]'],
    ['bearer AAAAAAAAAAAAAAAAAAAAAExmpl%2Fxyz', 'bearer [secret]'],
    ['secret Zq9~fake~Example12345abcdefXYZ', 'secret [secret]'],
    ['value 4f0e Zq9~fake~Example12345abcdefXYZ00', 'value 4f0e [secret]'],
    ['id 12345678-aaaa-4bbb-8ccc-1234567890ab', 'id [secret]'],
    ['mail me at someone@example.com or +15550000000', 'mail me at [email] or [number]'],
    ['the password reset flow and the token refresh bug', 'the password reset flow and the token refresh bug'],
    ['read acme-ffmpeg7-linux-trap notes', 'read acme-ffmpeg7-linux-trap notes'],
    ['be 100% sure and dont assume', 'be 100% sure and dont assume'],
    // Labels inside longer names, quoted values, and other shapes a reviewer found getting through.
    ['db_password: Hunter2!xyz', 'db_password: [secret]'],
    ['"db_password": "Hunter2!"', '"db_password": [secret]'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = [secret]'],
    ['stripeSecretKey: abcdEFGH1234', 'stripeSecretKey: [secret]'],
    ['authToken: a1b2c3d4e5', 'authToken: [secret]'],
    ['google_client_secret: GOCSPX-abcdefgh', 'google_client_secret: [secret]'],
    ['pass: Hunter2!', 'pass: [secret]'],
    ['pw Hunter2!xyz', 'pw [secret]'],
    ['$env:X_TOKEN = "abc def ghi"', '$env:X_TOKEN=[secret]'],
    ['postgres://user:p@ss@host/db', 'postgres://[secret]@host/db'],
    ['my code is 123456', 'my code is [secret]'],
    ['call 555 123 4567 or 555-123-4567 or (555) 123-4567', 'call [number] or [number] or [number]'],
    ['blob QmFzZTY0IGlzIG5vdCBhIHNlY3JldC4/Ab12Cd34+Ef56Gh78', 'blob [secret]'],
    // A label followed by ordinary words keeps them, so the habit words still count.
    ['Key question: are you sure?', 'Key question: are you sure?'],
    ['the password reset page: do a full review, dont assume', 'the password reset page: do a full review, dont assume'],
    ['check the token at https://example.com and be 100% sure', 'check the token at https://example.com and be 100% sure'],
    ['Key point: the follow-up matters', 'Key point: the follow-up matters'],
    ['see apps/backend/src/modules/reel/sample-reel.service.ts', 'see apps/backend/src/modules/reel/sample-reel.service.ts'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('the reply before a pushback is redacted before it is cut, so a cut never frees a value', async () => {
  const config = tempDir();
  const value = 'Hunter2!xyzQ';
  session(config, 'p', 's1', [human('go'), reply(`Set it up. password: ${value} ${'b'.repeat(387)}`), human('that is wrong, recheck it')]);
  const [, second] = (await readRecent(path.join(config, 'projects'), 20)).sessions[0].prompts;
  assert.equal(second.pushback, true);
  assert.doesNotMatch(second.before, /Hunter2/);
});

test('the words command writes a private temp file, counts, and deletes only its own files', () => {
  const config = tempDir();
  session(config, 'p', 's1', [human('Be 100% sure. Password: Hunter2!'), human('are you sure?')]);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  const run = (...args) => spawnSync('node', [CLI, 'words', ...args], { encoding: 'utf8', env });

  const out = run();
  assert.equal(out.status, 0, out.stderr);
  const file = /Wrote (\S+\.md)\./.exec(out.stdout)[1];
  try {
    assert.match(out.stdout, /Read 1 session\(s\) with prompts you typed.*: 2 prompt\(s\)/);
    assert.match(out.stdout, /1 prompt\(s\), {2}1 session\(s\) {2}"are you sure\?"/);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /Password: \[secret\]/);
    assert.doesNotMatch(text, /Hunter2/);

    assert.match(run('--count', 'are you', '--count', 'nothing like this').stdout, /1 prompt\(s\), {2}1 session\(s\) {2}\/are you\/i\n {3}0 prompt/);

    const elsewhere = path.join(tempDir(), 'first-pass-words-000000000000.md');
    fs.writeFileSync(elsewhere, 'x');
    assert.notEqual(run('--delete', elsewhere).status, 0);
    assert.ok(fs.existsSync(elsewhere), 'a file outside the temp folder is never deleted');
    assert.notEqual(run('--delete', CLI).status, 0);
    assert.equal(run('--delete', file).status, 0);
    assert.equal(fs.existsSync(file), false);
    const again = run('--delete', file);
    assert.notEqual(again.status, 0, 'a file that is not there is never reported as deleted');
    assert.match(again.stderr, /was not found/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a new run removes words files an unfinished run left more than 6 hours ago, and no others', () => {
  const config = tempDir();
  session(config, 'p', 's1', [human('be sure')]);
  const old = path.join(os.tmpdir(), 'first-pass-words-0000000000aa.md');
  const recent = path.join(os.tmpdir(), 'first-pass-words-0000000000bb.md');
  const lookalike = path.join(os.tmpdir(), 'first-pass-words-notmine.md');
  for (const file of [old, recent, lookalike]) fs.writeFileSync(file, 'x');
  const hoursAgo = (h) => (Date.now() - h * 3600_000) / 1000;
  fs.utimesSync(old, hoursAgo(7), hoursAgo(7));
  fs.utimesSync(lookalike, hoursAgo(7), hoursAgo(7));
  let written;
  try {
    const out = spawnSync('node', [CLI, 'words'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    written = /Wrote (\S+\.md)\./.exec(out.stdout)?.[1];
    assert.match(out.stdout, /Removed \d+ words file\(s\) older than 6 hours/);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(lookalike), true);
  } finally {
    for (const file of [old, recent, lookalike, written].filter(Boolean)) fs.rmSync(file, { force: true });
  }
});

test('the reminder: due after enough new sessions, never for the default list, and when only a profile is there', () => {
  const config = tempDir();
  const root = tempDir();
  const env = { CLAUDE_CONFIG_DIR: config };
  const agents = path.join(root, 'AGENTS.md');
  const block = (marker) => `<!-- first-pass:profile:start v0.2.0 -->\n<!-- first-pass:profile:end -->\n<!-- first-pass:words:start v0.2.0 ${marker} -->\n<!-- first-pass:words:end -->\n`;

  fs.writeFileSync(agents, '<!-- first-pass:profile:start v0.2.0 -->\n<!-- first-pass:profile:end -->\n');
  assert.match(wordsDue([root], env), /has the profile block but no habit words block/);

  fs.writeFileSync(agents, block('default (the default list)'));
  assert.equal(wordsDue([root], env), null);

  const through = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(agents, block(`through ${through} from 20 sessions`));
  for (let i = 0; i < WORDS_DUE_AFTER - 1; i++) session(config, 'p', `s${i}`, [human('x')]);
  session(config, 'p', 'before', [human('x')], Date.now() - 7200_000);
  // Sessions a script started (a release test, a headless run) hold no typed prompt.
  for (let i = 0; i < WORDS_DUE_AFTER + 5; i++) session(config, 'p', `script${i}`, [{ type: 'user', uuid: `sdk${i}`, turnOrigin: 'sdk', message: { content: 'automated' } }]);
  assert.equal(wordsDue([root], env), null);
  session(config, 'p', 'one-more', [human('x')]);
  assert.match(wordsDue([root], env), new RegExp(`at least ${WORDS_DUE_AFTER} sessions the user typed in`));

  // Said once per real start: not again after a compaction or a resume.
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    fs.writeFileSync(path.join(config, 'CLAUDE.md'), block(`through ${through} from 20 sessions`));
    const cwd = tempDir();
    assert.match(drift(null, { cwd, source: 'startup' }, '0.2.0').join('\n'), /habit words were read/);
    assert.doesNotMatch(drift(null, { cwd, source: 'compact' }, '0.2.0').join('\n'), /habit words were read/);
    assert.doesNotMatch(drift(null, { cwd, source: 'resume' }, '0.2.0').join('\n'), /habit words were read/);
  } finally {
    fs.rmSync(path.join(config, 'CLAUDE.md'), { force: true });
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }

  fs.writeFileSync(agents, block('through not-a-date'));
  assert.match(wordsDue([root], env), /no readable "through" date/);

  // A personal block in the user's own global file counts for a folder whose file has only the profile.
  fs.writeFileSync(agents, '<!-- first-pass:profile:start v0.2.0 -->\n<!-- first-pass:profile:end -->\n');
  fs.writeFileSync(path.join(config, 'CLAUDE.md'), block(`through ${new Date(Date.now() + 60_000).toISOString()} from 20 sessions`));
  assert.equal(wordsDue([root], env), null);
});

test('a stale profile block is reported even where the rules are current', () => {
  const config = tempDir();
  const repo = tempDir();
  spawnSync('git', ['init', '-q', repo]);
  const rules = (v) => `<!-- first-pass:rules:start v${v} -->\n<!-- first-pass:rules:end -->\n`;
  const profile = (v) => `<!-- first-pass:profile:start v${v} -->\n<!-- first-pass:profile:end -->\n`;
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    // A teammate pulls a repo whose rules are current; their own profile (one-repo mode puts
    // it in the user's CLAUDE.md) is from the release before.
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), rules('0.3.0'));
    fs.writeFileSync(path.join(config, 'CLAUDE.md'), profile('0.2.0'));
    assert.match(drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join('\n'), /the profile block in .*CLAUDE\.md is v0\.2\.0 and the plugin is v0\.3\.0/);

    fs.writeFileSync(path.join(config, 'CLAUDE.md'), profile('0.3.0'));
    assert.doesNotMatch(drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join('\n'), /the profile block in .* is v/);

    // A current profile in the folder does not hide an old one in the global file: both load.
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), rules('0.3.0') + profile('0.3.0'));
    fs.writeFileSync(path.join(config, 'CLAUDE.md'), profile('0.2.0'));
    assert.match(drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join('\n'), /the profile block in .*CLAUDE\.md is v0\.2\.0 and the plugin is v0\.3\.0/);

    // The global copy is outside what a main folder's setup writes, so its line says what does fix it.
    assert.match(drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join(' '), /in one-repo mode updates it, or remove it/);

    // An old profile in the folder's own file is one setup rewrites.
    fs.writeFileSync(path.join(config, 'CLAUDE.md'), profile('0.3.0'));
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), rules('0.3.0') + profile('0.2.0'));
    assert.match(drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join(' '), /AGENTS.md is v0.2.0 and the plugin is v0.3.0; re-running setup-first-pass updates it[.]/);

    // Rules and profile in one old file: one line asks for the re-run, not two.
    fs.writeFileSync(path.join(config, 'CLAUDE.md'), profile('0.3.0'));
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), rules('0.2.0') + profile('0.2.0'));
    const lines = drift(null, { cwd: repo, source: 'startup' }, '0.3.0').join('\n');
    assert.match(lines, /the rules block in .* is v0\.2\.0/);
    assert.doesNotMatch(lines, /the profile block in .* is v/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
