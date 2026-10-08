import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PartsError, Runner, alive, checkWrapper, inputsHash, loadRecipe, lock, logsDir, partsRoot, procIsOurs, readEnvFile, readMark, stopTree, unlock } from '../scripts/lib/parts.mjs';

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url));
const NODE = `"${process.execPath}"`;
const BASE_PORT = 41000 + Math.floor(Math.random() * 2000) * 4;
let nextRun = 0;
// Folders are removed even when a test fails before its own cleanup.
const made = [];
after(() => made.forEach((cleanup) => cleanup()));

// Stand-ins for a repo's tests and server, as node scripts the recipe runs through the shell.
const SCRIPTS = {
  'pass.js': `console.log('Tests: 3 passed, 3 total'); if (process.argv[2]) require('fs').writeFileSync(process.argv[2], String(Date.now()));`,
  'fail.js': `console.log('Tests: 1 failed, 1 total'); process.exit(1);`,
  'quiet.js': `process.exit(0);`,
  'sleep.js': `const fs = require('fs'); const [ms, out] = process.argv.slice(2); if (out) fs.writeFileSync(out + '.start', String(Date.now())); fs.writeFileSync(out ? out + '.pid' : 'sleep.pid', String(process.pid)); setTimeout(() => { if (out) fs.writeFileSync(out + '.end', String(Date.now())); console.log('Tests: 1 passed'); }, Number(ms));`,
  'touch.js': `require('fs').writeFileSync(process.argv[2], process.argv[3] ?? 'x');`,
  'envdump.js': `const fs = require('fs'); fs.writeFileSync(process.argv[2], JSON.stringify({ A: process.env.SECRET_A, B: process.env.PLAIN_B, PORT: process.env.MY_PORT })); console.log('Tests: 1 passed');`,
  'readfile.js': `const fs = require('fs'); if (fs.readFileSync(process.argv[2], 'utf8') !== process.argv[3]) process.exit(3); console.log('Tests: 1 passed');`,
  // A server that starts a child of its own, as next dev does, and says ready once it listens.
  'server.js': `const http = require('http'); const { spawn } = require('child_process'); const fs = require('fs');
    const [port, pids, mode] = process.argv.slice(2);
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(pids, JSON.stringify([process.pid, kid.pid]));
    if (mode === 'never') { setInterval(() => {}, 1000); }
    else http.createServer((q, s) => s.end('ok')).listen(Number(port), '127.0.0.1', () => console.log(' Ready in 1s'));`,
  // Another run's server takes the port, then this one fails to bind and exits.
  'stolen.js': `const { spawn } = require('child_process'); const fs = require('fs'); const [port, pidFile] = process.argv.slice(2);
    const decoy = spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end('x')).listen(" + port + ", '127.0.0.1', () => console.log('Ready in 1s'))"], { stdio: 'ignore', detached: true, cwd: require('os').tmpdir() });
    fs.writeFileSync(pidFile, String(decoy.pid)); decoy.unref(); setTimeout(() => process.exit(1), 1500);`,
  // The machine's wrapper: records what it was given, then runs the command file it was handed.
  'wrapper.js': `const fs = require('fs'); const { spawnSync } = require('child_process'); const [out, name, gb, min, file] = process.argv.slice(2);
    fs.appendFileSync(out, JSON.stringify({ name, gb, min }) + '\\n');
    const r = spawnSync(fs.readFileSync(file, 'utf8').trim(), { shell: true, stdio: 'inherit' }); process.exit(r.status ?? 1);`,
};

function fixture(recipe, { envText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-parts-test-'));
  const repo = path.join(dir, 'repo');
  const co = path.join(dir, 'co');
  const bin = path.join(dir, 'bin');
  for (const d of [path.join(repo, '.first-pass'), path.join(co, 'src'), bin]) fs.mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(bin, name), text);
  fs.writeFileSync(path.join(co, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(co, 'src', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(co, '.gitignore'), 'dist/\n');
  git(co, 'init', '-q');
  git(co, 'add', '-A');
  git(co, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  if (envText !== undefined) fs.writeFileSync(path.join(repo, '.env.local'), envText);
  const s = (name, ...args) => [NODE, `"${path.join(bin, name)}"`, ...args.map((a) => `"${a}"`)].join(' ');
  const text = JSON.stringify(typeof recipe === 'function' ? recipe({ s, dir, co }) : recipe, null, 2);
  fs.writeFileSync(path.join(repo, '.first-pass', 'parts.json'), text);
  const logsParent = path.dirname(logsDir(repo, 'x'));
  const cleanup = () => {
    fs.rmSync(logsParent, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  made.push(cleanup);
  return { dir, repo, co, bin, s, run: `t${process.pid}x${nextRun++}`, cleanup };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function runner(f, names, extra = {}) {
  const lines = [];
  const r = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l), ...extra });
  const ok = await r.runParts(names);
  fs.rmSync(r.logs, { recursive: true, force: true });
  return { ok, lines, text: lines.join('\n') };
}

const one = (steps, more = {}) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { steps, ...more } } });

test('the recipe is refused for unknown or out-of-place placeholders, non-local servers and misplaced parts', () => {
  const cases = [
    [one([{ name: 'a', run: 'x {{nope}}' }]), /not a placeholder/],
    [one([{ name: 'a', run: 'x {{port}}' }]), /no value in this part/],
    [one([{ name: 'a', run: 'x {{shard}}' }]), /no value in this part/],
    [one([{ name: 'a', run: 'x' }], { server: { run: 's', ready: 'r', url: 'http://example.com:{{port}}/', ports: [5000, 5001] } }), /on this machine/],
    [one([{ name: 'a', run: 'x' }], { server: { run: 's', ready: 'r', url: 'http://localhost.example.com/', ports: [5000, 5001] } }), /on this machine/],
    [one([{ name: 'a', run: 'x', ran: '(' }]), /not a regex/],
    [{ firstPassParts: 1, stages: [], parts: { p: { steps: [{ name: 'a', run: 'x' }] } } }, /in 0 stages/],
    [{ firstPassParts: 1, stages: [['p', 'q']], parts: { p: { steps: [{ name: 'a', run: 'x' }] }, q: { needs: ['p'], steps: [{ name: 'a', run: 'x' }] } } }, /earlier stage/],
    [{ firstPassParts: 1, stages: [['p']], parts: { p: { needs: ['zz'], steps: [{ name: 'a', run: 'x' }] } } }, /not a part/],
    [one([{ name: 'a', run: 'x', requried: true }]), /"requried" is not a field/],
    [one([{ name: 'a', run: 'x' }], { timeout: 5 }), /"timeout" is not a field/],
    [one([{ name: 'a', run: 'x' }], { env: { A: 1 } }), /maps names to text/],
  ];
  for (const [recipe, error] of cases) {
    const f = fixture(recipe);
    assert.throws(() => loadRecipe(f.repo), error);
    f.cleanup();
  }
});

test('shards expand to one part each, and a part that needs the group needs every shard', () => {
  const f = fixture({ firstPassParts: 1, stages: [['flows'], ['after']], parts: { flows: { shards: 3, steps: [{ name: 'a', run: 'x {{shard}}/{{shards}}' }] }, after: { needs: ['flows'], steps: [{ name: 'a', run: 'x' }] } } });
  const recipe = loadRecipe(f.repo);
  assert.deepEqual(recipe.stages, [['flows-1', 'flows-2', 'flows-3'], ['after']]);
  assert.deepEqual(recipe.parts.get('after').needs, ['flows-1', 'flows-2', 'flows-3']);
  assert.equal(recipe.parts.get('flows-2').shard, 2);
  f.cleanup();
});

test('parts of a stage run side by side, and stages one after another', async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['a', 'b'], ['c']],
    parts: {
      a: { steps: [{ name: 's', run: s('sleep.js', '1500', path.join(dir, 'a')), ran: 'passed' }] },
      b: { steps: [{ name: 's', run: s('sleep.js', '1500', path.join(dir, 'b')), ran: 'passed' }] },
      c: { steps: [{ name: 's', run: s('sleep.js', '10', path.join(dir, 'c')), ran: 'passed' }] },
    },
  }));
  const r = await runner(f, ['a', 'b', 'c']);
  assert.equal(r.ok, true, r.text);
  const t = (n, e) => Number(fs.readFileSync(path.join(f.dir, `${n}.${e}`), 'utf8'));
  assert.ok(t('b', 'start') < t('a', 'end') && t('a', 'start') < t('b', 'end'), 'a and b overlapped');
  assert.ok(t('c', 'start') >= Math.max(t('a', 'end'), t('b', 'end')), 'c started after the first stage');
  f.cleanup();
});

test('a step whose log has no test totals fails the part; a required failure stops it, another does not', async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['quiet', 'req', 'soft']],
    parts: {
      quiet: { steps: [{ name: 't', run: s('quiet.js'), ran: '^Tests:' }] },
      req: { steps: [{ name: 'x', run: s('fail.js'), required: true }, { name: 'y', run: s('touch.js', path.join(dir, 'req-y')) }] },
      soft: { steps: [{ name: 'x', run: s('fail.js') }, { name: 'y', run: s('touch.js', path.join(dir, 'soft-y')) }] },
    },
  }));
  const r = await runner(f, ['quiet', 'req', 'soft']);
  assert.equal(r.ok, false);
  assert.match(r.text, /quiet t ran no tests/);
  assert.match(r.text, /=== quiet FAILED/);
  assert.equal(fs.existsSync(path.join(f.dir, 'req-y')), false, 'a required failure stops the part');
  assert.equal(fs.existsSync(path.join(f.dir, 'soft-y')), true, 'any other failure lets the rest run');
  assert.match(r.text, /=== soft FAILED/);
  f.cleanup();
});

test('a part refuses to run until what it needs has passed on this checkout with the same inputs', async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['prep'], ['use']],
    parts: {
      prep: { inputs: ['src'], steps: [{ name: 'b', run: s('pass.js') }] },
      use: { needs: ['prep'], steps: [{ name: 't', run: s('touch.js', path.join(dir, 'used')) }] },
    },
  }));
  const raw = JSON.parse(fs.readFileSync(path.join(f.repo, '.first-pass', 'parts.json'), 'utf8'));
  const lines = [];
  const make = () => new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) });
  const used = () => fs.existsSync(path.join(f.dir, 'used')) && (fs.rmSync(path.join(f.dir, 'used')), true);

  assert.equal(await make().runParts(['use']), false);
  assert.match(lines.join('\n'), /needs prep, which has not passed/);
  assert.equal(used(), false);

  assert.equal(await make().runParts(['prep']), true);
  assert.equal(await make().runParts(['use']), true);
  assert.equal(used(), true);

  // A changed input copied with its old file time still counts.
  const a = path.join(f.co, 'src', 'a.ts');
  const old = fs.statSync(a).mtime;
  fs.writeFileSync(a, 'export const a = 99;\n');
  fs.utimesSync(a, old, old);
  lines.length = 0;
  assert.equal(await make().runParts(['use']), false);
  assert.match(lines.join('\n'), /prep's inputs changed/);

  assert.equal(await make().runParts(['prep']), true);
  fs.rmSync(path.join(f.co, 'src', 'b.ts'));
  lines.length = 0;
  assert.equal(await make().runParts(['use']), false, 'a deleted input counts');
  assert.match(lines.join('\n'), /prep's inputs changed/);

  // A rerun that fails takes the old pass away.
  assert.equal(await make().runParts(['prep']), true);
  raw.parts.prep.steps[0].run = raw.parts.prep.steps[0].run.replace('pass.js', 'fail.js');
  fs.writeFileSync(path.join(f.repo, '.first-pass', 'parts.json'), JSON.stringify(raw));
  assert.equal(await make().runParts(['prep']), false);
  lines.length = 0;
  assert.equal(await make().runParts(['use']), false);
  assert.match(lines.join('\n'), /needs prep, which has not passed/);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('a run name belongs to its first checkout, however the path is spelled, and never the working tree', () => {
  const f = fixture(one([{ name: 'a', run: 'x' }]));
  const other = fixture(one([{ name: 'a', run: 'x' }]));
  const recipe = loadRecipe(f.repo);
  new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe, out: () => {} });
  const respelled = path.join(f.co, '..', path.basename(f.co), '.');
  new Runner({ repo: f.repo, checkout: process.platform === 'win32' ? respelled.toUpperCase() : respelled, run: f.run, recipe, out: () => {} });
  assert.throws(() => new Runner({ repo: f.repo, checkout: other.co, run: f.run, recipe, out: () => {} }), /belongs to/);
  assert.throws(() => new Runner({ repo: f.repo, checkout: f.repo, run: 'other', recipe, out: () => {} }), /clean checkout/);
  assert.throws(() => new Runner({ repo: f.repo, checkout: f.co, run: 'Bad_Name', recipe, out: () => {} }), /lowercase/);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
  other.cleanup();
});

test('on Linux a killed process its parent has not reaped yet (a zombie) holds no lock', { skip: process.platform !== 'linux' }, async () => {
  // The shell starts a short sleep, then becomes node, which never reaps that sleep.
  const parent = spawn('sh', ['-c', "sleep 0.2 & echo $!; exec node -e 'setInterval(() => {}, 1000)'"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const zombie = Number(await new Promise((r) => parent.stdout.once('data', (d) => r(String(d).trim()))));
  await new Promise((r) => setTimeout(r, 1000));
  const state = fs.readFileSync(`/proc/${zombie}/stat`, 'utf8');
  parent.kill('SIGKILL');
  assert.match(state.slice(state.lastIndexOf(') ') + 2), /^Z/, 'the sleep is a zombie');
  assert.equal(alive(zombie), false);
});

test('on Linux a process reaped while it is being checked reads as gone, never a crash', { skip: process.platform !== 'linux' }, async () => {
  for (let i = 0; i < 300; i++) {
    const sh = spawn('sh', ['-c', 'sleep 0.02 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(await new Promise((r) => sh.stdout.once('data', (d) => r(String(d).trim()))));
    while (alive(pid)) {
      // checked again and again while the shell reaps it
    }
    await new Promise((r) => sh.once('exit', r));
  }
});

test("on Linux /proc is trusted only when it is this process's own", { skip: process.platform !== 'linux' }, (t) => {
  assert.equal(procIsOurs(), true);
  // A new pid namespace that keeps the outer /proc: its pids are not the ones /proc shows.
  const lib = new URL('../scripts/lib/parts.mjs', import.meta.url).href;
  const r = spawnSync('unshare', ['-p', '-f', '--', process.execPath, '--input-type=module', '-e', `import { procIsOurs } from '${lib}'; console.log(procIsOurs());`], { encoding: 'utf8', timeout: 30000 });
  // Skipped only when unshare itself refuses; an error from the code under test fails it.
  if (r.error || (r.status !== 0 && r.stderr.startsWith('unshare:'))) {
    t.skip(`no pid namespace here: ${(r.error?.message ?? r.stderr).trim().split('\n')[0]}`);
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'false');
});

test('a lock held by a live process is respected, and one left by a dead process is taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-lock-'));
  const file = path.join(dir, 'x.lock');
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  fs.writeFileSync(file, dead.stdout.trim());
  assert.equal(alive(Number(dead.stdout.trim())), false);
  assert.equal(lock(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(file, String(holder.pid));
  assert.equal(lock(file), false);
  unlock(file);
  assert.equal(fs.existsSync(file), true, 'never removes a lock another process holds');
  holder.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const serverPart = (s, dir, mode = 'ok', lo = BASE_PORT) => ({
  server: { run: s('server.js', '{{port}}', path.join(dir, 'pids.json'), mode), ready: 'Ready in', url: 'http://127.0.0.1:{{port}}/', ports: [lo, lo + 3], timeoutSec: mode === 'never' ? 4 : 30 },
  steps: [{ name: 't', run: s('touch.js', path.join(dir, 'port'), '{{port}}') }],
});

async function waitDead(pids) {
  for (let i = 0; i < 40 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 250));
  return !pids.some(alive);
}

test('a server part skips a port that is in use, and stops its server and the server\'s own children', async () => {
  const blocker = net.createServer().listen(BASE_PORT, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: serverPart(s, dir) } }));
  const r = await runner(f, ['p']);
  blocker.close();
  assert.equal(r.ok, true, r.text);
  assert.equal(Number(fs.readFileSync(path.join(f.dir, 'port'), 'utf8')), BASE_PORT + 1);
  const pids = JSON.parse(fs.readFileSync(path.join(f.dir, 'pids.json'), 'utf8'));
  assert.equal(await waitDead(pids), true, 'the server and its child are gone');
  assert.doesNotMatch(r.text, /still in use/);
  f.cleanup();
});

test('a server that never says ready fails the part and is stopped', async () => {
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: serverPart(s, dir, 'never', BASE_PORT + 4) } }));
  const r = await runner(f, ['p']);
  assert.equal(r.ok, false);
  assert.match(r.text, /server did not start/);
  assert.equal(fs.existsSync(path.join(f.dir, 'port')), false, 'no step ran');
  assert.equal(await waitDead(JSON.parse(fs.readFileSync(path.join(f.dir, 'pids.json'), 'utf8'))), true);
  f.cleanup();
});

test('another run\'s server answering on the port is never taken for this part\'s own', async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['p']],
    parts: { p: { server: { run: s('stolen.js', '{{port}}', path.join(dir, 'decoy.pid')), ready: 'Ready in', url: 'http://127.0.0.1:{{port}}/', ports: [BASE_PORT + 8, BASE_PORT + 11], timeoutSec: 20 }, steps: [{ name: 't', run: s('touch.js', path.join(dir, 'ran')) }] } },
  }));
  const r = await runner(f, ['p']);
  const decoy = Number(fs.readFileSync(path.join(f.dir, 'decoy.pid'), 'utf8'));
  process.kill(decoy);
  assert.equal(await waitDead([decoy]), true);
  assert.equal(r.ok, false);
  assert.match(r.text, /server did not start/);
  assert.equal(fs.existsSync(path.join(f.dir, 'ran')), false);
  f.cleanup();
});

test('env file keys reach the part and its placeholders, a missing key fails it, and no value is ever printed', async () => {
  const envText = 'export SECRET_A="s3cr3t-value"\r\nPLAIN_B=plain # comment\r\nOTHER=ignored\r\n';
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { envFile: { path: '.env.local', keys: ['SECRET_A', 'PLAIN_B'] }, env: { MY_PORT: 'run-{{run}}' }, steps: [{ name: 't', run: s('envdump.js', path.join(dir, 'env.json')), ran: 'passed' }] } } }), { envText });
  const r = await runner(f, ['p']);
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'env.json'), 'utf8')), { A: 's3cr3t-value', B: 'plain', PORT: `run-${f.run}` });
  assert.doesNotMatch(r.text, /s3cr3t/);
  f.cleanup();

  const g = fixture(({ s }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { envFile: { path: '.env.local', keys: ['SECRET_A', 'MISSING_C'] }, steps: [{ name: 't', run: s('pass.js') }] } } }), { envText });
  const r2 = await runner(g, ['p']);
  assert.equal(r2.ok, false);
  assert.match(r2.text, /no value for MISSING_C/);
  assert.doesNotMatch(r2.text, /s3cr3t/);
  g.cleanup();
});

test('readEnvFile reads quotes, export and comments, and refuses a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-env-'));
  fs.writeFileSync(path.join(dir, '.env'), "A='one two'\nexport B=two # note\nB=second\nC=\"x#y\"\n");
  assert.deepEqual(readEnvFile(dir, { path: '.env', keys: ['A', 'B', 'C'] }), { A: 'one two', B: 'two', C: 'x#y' });
  assert.throws(() => readEnvFile(dir, { path: 'nope', keys: ['A'] }), /is missing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a part writes its files before its steps and removes them after, and never overwrites one', async () => {
  const f = fixture(({ s, co }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { files: { 'cfg/run-{{run}}.txt': 'for {{run}}' }, steps: [{ name: 't', run: s('readfile.js', path.join(co, 'cfg', 'run-{{run}}.txt'), 'for {{run}}'), ran: 'passed' }] } } }));
  const r = await runner(f, ['p']);
  assert.equal(r.ok, true, r.text);
  assert.equal(fs.existsSync(path.join(f.co, 'cfg', `run-${f.run}.txt`)), false);
  fs.mkdirSync(path.join(f.co, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(f.co, 'cfg', `run-${f.run}.txt`), 'mine');
  const r2 = await runner(f, ['p']);
  assert.equal(r2.ok, false);
  assert.match(r2.text, /already exists/);
  assert.equal(fs.readFileSync(path.join(f.co, 'cfg', `run-${f.run}.txt`), 'utf8'), 'mine');
  f.cleanup();
});

test('cleanup runs after a failed step, with the part\'s placeholders', async () => {
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { shards: 2, steps: [{ name: 't', run: s('fail.js') }], cleanup: [{ name: 'drop', run: s('touch.js', path.join(dir, 'dropped-{{shard}}')) }] } } }));
  const r = await runner(f, ['p-1', 'p-2']);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'dropped-1')), true);
  assert.equal(fs.existsSync(path.join(f.dir, 'dropped-2')), true);
  f.cleanup();
});

test('a part past its time limit is stopped, with what its step started', async () => {
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { timeoutMin: 0.05, steps: [{ name: 't', run: s('sleep.js', '60000', path.join(dir, 'slow')) }] } } }));
  const started = Date.now();
  const r = await runner(f, ['p']);
  assert.equal(r.ok, false);
  assert.match(r.text, /TIMED OUT/);
  assert.ok(Date.now() - started < 30000);
  assert.equal(await waitDead([Number(fs.readFileSync(path.join(f.dir, 'slow.pid'), 'utf8'))]), true);
  f.cleanup();
});

test('with a wrapper, each part runs through it as its own run of the CLI, and its exit code is the result', async () => {
  const f = fixture(({ s }) => ({ firstPassParts: 1, stages: [['ok', 'bad']], parts: { ok: { memoryGB: 6, timeoutMin: 10, steps: [{ name: 't', run: s('pass.js'), ran: 'passed' }] }, bad: { steps: [{ name: 't', run: s('fail.js') }] } } }));
  const out = path.join(f.dir, 'wrapped.jsonl');
  const wrapper = checkWrapper([process.execPath, path.join(f.bin, 'wrapper.js'), out, '{{name}}', '{{memoryGB}}', '{{timeoutMin}}', '{{commandFile}}']);
  const lines = [];
  const r = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), wrapper, cli: CLI, out: (l) => lines.push(l) });
  assert.equal(await r.runParts(['ok', 'bad']), false);
  const calls = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(calls, [{ name: 'bad', gb: '4', min: '35' }, { name: 'ok', gb: '6', min: '15' }]);
  const summary = fs.readFileSync(path.join(r.logs, 'summary.txt'), 'utf8');
  assert.match(summary, /=== ok passed/);
  assert.match(summary, /=== bad FAILED/);
  assert.match(lines.join('\n'), /ok through the wrapper exit=0/);
  assert.match(lines.join('\n'), /bad through the wrapper exit=1/);
  fs.rmSync(r.logs, { recursive: true, force: true });
  f.cleanup();
});

test('a wrapper that exits 0 without running the part is not a pass', async () => {
  const f = fixture(({ s }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { steps: [{ name: 't', run: s('fail.js') }] } } }));
  const lines = [];
  const r = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), wrapper: [process.execPath, '-e', 'process.exit(0)', '{{commandFile}}'], cli: CLI, out: (l) => lines.push(l) });
  assert.equal(await r.runParts(['p']), false);
  assert.match(lines.join('\n'), /exited 0 but the part never passed/);
  fs.rmSync(r.logs, { recursive: true, force: true });
  f.cleanup();
});

const waitFor = async (file) => {
  for (let i = 0; i < 120 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250));
  return fs.existsSync(file);
};

// A wrapped part with a file, a cleanup and a step that runs a minute, stopped while it runs.
const stoppable = () =>
  fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['p']],
    parts: {
      p: {
        files: { 'cfg/{{run}}.txt': 'x' },
        steps: [{ name: 't', run: s('sleep.js', '60000', path.join(dir, 'slow')) }],
        cleanup: [{ name: 'c', run: s('touch.js', path.join(dir, 'cleaned')) }],
      },
    },
  }));

test('stopping a wrapped run lets the part clean up, and the next run of that name passes', async () => {
  const f = stoppable();
  const wrapper = [process.execPath, path.join(f.bin, 'wrapper.js'), path.join(f.dir, 'w.jsonl'), '{{name}}', '{{memoryGB}}', '{{timeoutMin}}', '{{commandFile}}'];
  const r = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), wrapper, cli: CLI, out: () => {} });
  const running = r.runParts(['p']);
  assert.equal(await waitFor(path.join(f.dir, 'slow.pid')), true, 'the step started');
  await r.stopAll();
  assert.equal(await running, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'cleaned')), true, 'its cleanup ran');
  assert.equal(fs.existsSync(path.join(f.co, 'cfg', `${f.run}.txt`)), false, 'its file was removed');
  assert.equal(await waitDead([Number(fs.readFileSync(path.join(f.dir, 'slow.pid'), 'utf8'))]), true);
  const raw = JSON.parse(fs.readFileSync(path.join(f.repo, '.first-pass', 'parts.json'), 'utf8'));
  raw.parts.p.steps[0].run = raw.parts.p.steps[0].run.replace(/sleep\.js.*$/, 'pass.js"');
  fs.writeFileSync(path.join(f.repo, '.first-pass', 'parts.json'), JSON.stringify(raw));
  const again = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), wrapper, cli: CLI, out: () => {} });
  assert.equal(await again.runParts(['p']), true);
  fs.rmSync(r.logs, { recursive: true, force: true });
  f.cleanup();
});

test('a part killed before its cleanup is cleaned up by the next run of it, which then runs', async () => {
  const f = stoppable();
  const wrapper = [process.execPath, path.join(f.bin, 'wrapper.js'), path.join(f.dir, 'w.jsonl'), '{{name}}', '{{memoryGB}}', '{{timeoutMin}}', '{{commandFile}}'];
  const r = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), wrapper, cli: CLI, out: () => {} });
  const running = r.runParts(['p']);
  assert.equal(await waitFor(path.join(f.dir, 'slow.pid')), true);
  const slow = Number(fs.readFileSync(path.join(f.dir, 'slow.pid'), 'utf8'));
  // A hard kill, no stop file: on Linux and macOS a SIGTERM would let the runner clean up itself,
  // and on Windows taskkill /T ends the deepest processes first, so the runner could see its step
  // die and clean up before its own turn: it is ended first.
  const owner = Number(fs.readFileSync(path.join(r.logs, 'p.lock'), 'utf8'));
  for (const child of r.active) {
    if (process.platform === 'win32') {
      process.kill(owner);
      await stopTree(child);
    } else {
      process.kill(-child.pid, 'SIGKILL');
      await child.done;
    }
  }
  assert.equal(await running, false);
  if (alive(slow)) process.kill(slow); // a process group the hard kill did not reach
  // The next run comes once the kill has finished: a killed process can take a moment to die.
  for (let i = 0; i < 60 && alive(owner); i++) await new Promise((res) => setTimeout(res, 250));
  assert.equal(alive(owner), false, 'the killed run is gone');
  assert.equal(fs.existsSync(path.join(f.co, 'cfg', `${f.run}.txt`)), true, 'the killed run left its file');
  assert.equal(fs.existsSync(path.join(f.dir, 'cleaned')), false, 'and did not clean up');
  const raw = JSON.parse(fs.readFileSync(path.join(f.repo, '.first-pass', 'parts.json'), 'utf8'));
  raw.parts.p.steps[0].run = raw.parts.p.steps[0].run.replace(/sleep\.js.*$/, 'pass.js"');
  fs.writeFileSync(path.join(f.repo, '.first-pass', 'parts.json'), JSON.stringify(raw));
  const lines = [];
  const again = new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) });
  assert.equal(await again.runParts(['p']), true, lines.join('\n'));
  assert.match(lines.join('\n'), /cleaning up after an earlier run/);
  assert.equal(fs.existsSync(path.join(f.dir, 'cleaned')), true, 'the earlier run\'s cleanup ran');
  fs.rmSync(r.logs, { recursive: true, force: true });
  f.cleanup();
});

test('a part refuses when one it needs passed before its own needs\' latest pass', async () => {
  const f = fixture(({ s }) => ({
    firstPassParts: 1,
    stages: [['a'], ['b'], ['c']],
    parts: { a: { steps: [{ name: 't', run: s('pass.js') }] }, b: { needs: ['a'], steps: [{ name: 't', run: s('pass.js') }] }, c: { needs: ['b'], steps: [{ name: 't', run: s('pass.js') }] } },
  }));
  const lines = [];
  const make = () => new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) });
  assert.equal(await make().runParts(['a', 'b']), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await make().runParts(['a']), true);
  assert.equal(await make().runParts(['c']), false);
  assert.match(lines.join('\n'), /b passed before a's latest pass: run b again/);
  assert.equal(await make().runParts(['b', 'c']), true);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('a planted leftover record cannot put its own values into commands or remove other files', async () => {
  const f = fixture(({ s, dir }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { steps: [{ name: 't', run: s('pass.js') }], cleanup: [{ name: 'c', run: s('touch.js', path.join(dir, 'cleaned-{{run}}')) }] } } }));
  const logs = logsDir(f.repo, f.run);
  fs.mkdirSync(logs, { recursive: true });
  const evil = path.join(f.dir, 'INJECTED');
  const bad = process.platform === 'win32' ? `x" & echo hi> "${evil}" & echo "` : `x"; echo hi > "${evil}"; echo "`;
  const keep = path.join(f.repo, 'keep.txt');
  fs.writeFileSync(keep, 'mine');
  const hash = createHash('sha1').update('mine').digest('hex');
  fs.writeFileSync(path.join(logs, 'p.leftover.json'), JSON.stringify({ vars: { run: bad, checkout: f.co, repo: f.repo, logs }, port: 'x', files: [{ file: keep, hash }] }));
  const r = await runner(f, ['p']);
  assert.equal(r.ok, true, r.text);
  assert.equal(fs.existsSync(evil), false, 'nothing from the record reached a shell');
  assert.equal(fs.existsSync(path.join(f.dir, `cleaned-${f.run}`)), true, "the cleanup ran with this run's own values");
  assert.equal(fs.existsSync(keep), true, "a file that is not the part's own was left alone");
  f.cleanup();
});

test('on Linux and macOS a runner folder others can write to is refused', { skip: process.platform === 'win32' }, () => {
  const f = fixture(({ s }) => ({ firstPassParts: 1, stages: [['p']], parts: { p: { steps: [{ name: 't', run: s('pass.js') }] } } }));
  const tmp = path.join(f.dir, 'tmp');
  fs.mkdirSync(path.join(tmp, 'first-pass-parts'), { recursive: true });
  fs.chmodSync(path.join(tmp, 'first-pass-parts'), 0o777);
  const r = spawnSync(process.execPath, [CLI, 'parts', f.repo, f.co, f.run, 'p'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp }, timeout: 60000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /others can write/);
  f.cleanup();
});

test("a part's mark records the passes of its needs as they were when it started", async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['a'], ['b'], ['c']],
    parts: { a: { steps: [{ name: 't', run: s('pass.js') }] }, b: { needs: ['a'], steps: [{ name: 't', run: s('sleep.js', '2000', path.join(dir, 'b')) }] }, c: { needs: ['b'], steps: [{ name: 't', run: s('pass.js') }] } },
  }));
  const lines = [];
  const make = () => new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) });
  assert.equal(await make().runParts(['a']), true);
  const b = make().runParts(['b']);
  assert.equal(await waitFor(path.join(f.dir, 'b.start')), true);
  assert.equal(await make().runParts(['a']), true, 'a is rerun while b runs');
  assert.equal(await b, false, 'b ran on the a from before the rerun');
  assert.match(lines.join('\n'), /b: a, which it needs, was run again while it ran: run b again/);
  assert.equal(await make().runParts(['c']), false);
  assert.match(lines.join('\n'), /needs b, which has not passed/);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('a part fails when a part it needs through another one is run again while it runs', async () => {
  const f = fixture(({ s, dir }) => ({
    firstPassParts: 1,
    stages: [['a'], ['b'], ['c']],
    parts: { a: { steps: [{ name: 't', run: s('pass.js') }] }, b: { needs: ['a'], steps: [{ name: 't', run: s('pass.js') }] }, c: { needs: ['b'], steps: [{ name: 't', run: s('sleep.js', '2000', path.join(dir, 'c')) }] } },
  }));
  const lines = [];
  const make = () => new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) });
  assert.equal(await make().runParts(['a', 'b']), true);
  const c = make().runParts(['c']);
  assert.equal(await waitFor(path.join(f.dir, 'c.start')), true);
  assert.equal(await make().runParts(['a']), true, 'a is rerun while c runs');
  assert.equal(await c, false);
  assert.match(lines.join('\n'), /c: a, which it needs, was run again while it ran/);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('a need whose rerun starts right after the start check still fails the part', async () => {
  const f = fixture(({ s }) => ({ firstPassParts: 1, stages: [['a'], ['b']], parts: { a: { steps: [{ name: 't', run: s('pass.js') }] }, b: { needs: ['a'], steps: [{ name: 't', run: s('pass.js') }] } } }));
  const lines = [];
  // The rerun of a removes its mark at its start; here that lands just after b's start check.
  class Gap extends Runner {
    notReady(part) {
      const result = super.notReady(part);
      if (part.name === 'b') fs.rmSync(this.markFile('a'), { force: true });
      return result;
    }
  }
  assert.equal(await new Runner({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: () => {} }).runParts(['a']), true);
  assert.equal(await new Gap({ repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: (l) => lines.push(l) }).runParts(['b']), false);
  assert.match(lines.join('\n'), /a, which it needs, was run again while it ran/);
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('the start check reads each mark once, so a need rerun during it cannot slip through', async () => {
  const f = fixture(({ s }) => ({
    firstPassParts: 1,
    stages: [['a', 'x'], ['b'], ['c']],
    parts: { a: { steps: [{ name: 't', run: s('pass.js') }] }, x: { steps: [{ name: 't', run: s('pass.js') }] }, b: { needs: ['x', 'a'], steps: [{ name: 't', run: s('pass.js') }] }, c: { needs: ['b'], steps: [{ name: 't', run: s('pass.js') }] } },
  }));
  const opts = { repo: f.repo, checkout: f.co, run: f.run, recipe: loadRecipe(f.repo), out: () => {} };
  assert.equal(await new Runner(opts).runParts(['a', 'x', 'b']), true);
  // During c's start check a rerun of a is under way (its mark gone), then has passed (a new mark).
  class Racy extends Runner {
    markFile(name) {
      const file = super.markFile(name);
      if (this.racing && name === 'a') {
        this.reads = (this.reads ?? 0) + 1;
        if (this.reads === 1) {
          this.old = JSON.parse(fs.readFileSync(file, 'utf8'));
          fs.rmSync(file);
        } else if (this.reads === 2) fs.writeFileSync(file, JSON.stringify({ ...this.old, at: new Date(Date.now() + 1000).toISOString() }));
      }
      return file;
    }
  }
  const racy = new Racy(opts);
  racy.racing = true;
  assert.equal(await racy.runParts(['c']), false, 'c never passes on the b built from the old a');
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});

test('a lock file that cannot be read once its create failed does not crash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A link to nothing: the exclusive create sees it, the read finds nothing, as when the holder
  // unlocks between the two.
  const file = path.join(dir, 'x.lock');
  try {
    fs.symlinkSync(path.join(dir, 'gone'), file);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('this Windows account cannot make links');
    return;
  }
  assert.doesNotThrow(() => lock(file));
  assert.doesNotThrow(() => unlock(file));
});

test('runs racing on one lock file or one mark never crash', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const lib = new URL('../scripts/lib/parts.mjs', import.meta.url).href;
  const lockFile = path.join(dir, 'p.lock');
  const mark = path.join(dir, 'm.json');
  fs.writeFileSync(mark, '{"at":"0"}');
  const loop = (body) => `const end = Date.now() + 2500; while (Date.now() < end) { ${body} }`;
  const children = [
    ...[1, 2, 3].map(() => [`import { lock, unlock } from '${lib}'; const f = process.argv[1]; ${loop('if (lock(f)) unlock(f);')}`, lockFile]),
    ...[1, 2].map(() => [`import { readMark } from '${lib}'; const f = process.argv[1]; ${loop('readMark(f);')}`, mark]),
    // Another run removing and rewriting the mark, as a rerun does; its own errors are not the test.
    [`import fs from 'node:fs'; const f = process.argv[1]; ${loop("try { fs.rmSync(f, { force: true }); fs.writeFileSync(f + '.tmp', '{\"at\":\"1\"}'); fs.renameSync(f + '.tmp', f); } catch (e) {}")}`, mark],
  ];
  const results = await Promise.all(
    children.map(([code, file]) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.once('exit', (code2) => resolve({ code: code2, err }));
    })),
  );
  for (const r of results) assert.equal(r.code, 0, r.err.split('\n').slice(0, 6).join('\n'));
});

test('a mark that is gone when it is read reads as no mark', () => {
  assert.equal(readMark(path.join(os.tmpdir(), `first-pass-no-such-mark-${process.pid}.json`)), null);
});

test('stopping a process that never started does nothing', async () => {
  await stopTree({ pid: undefined, exitCode: null, signalCode: null, done: Promise.resolve({ code: -1 }) });
});

test('a wrapper must pass the command and use known placeholders', () => {
  assert.throws(() => checkWrapper(['run-capped']), /must pass/);
  assert.throws(() => checkWrapper(['x', '{{cmd}}']), /not a placeholder/);
  assert.throws(() => checkWrapper('x {{command}}'), /list of strings/);
});

test('inputs need git; a checkout git cannot read is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-nogit-'));
  assert.throws(() => inputsHash(dir, ['src']), PartsError);
  assert.equal(inputsHash(dir, []), 'no inputs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI checks a recipe, runs it, and exits 2 on a usage or recipe error', () => {
  const f = fixture(({ s }) => ({ firstPassParts: 1, stages: [['a'], ['b']], parts: { a: { steps: [{ name: 't', run: s('pass.js'), ran: 'passed' }] }, b: { needs: ['a'], steps: [{ name: 't', run: s('pass.js') }] } } }));
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'parts', ...args], { encoding: 'utf8', timeout: 60000 });
  const checked = cli(f.repo, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /stage 1: a/);
  assert.match(checked.stdout, /stage 2: b \(needs a/);
  const ran = cli(f.repo, f.co, f.run, 'all');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /=== b passed/);
  assert.equal(cli(f.repo, f.co).status, 2);
  assert.equal(cli(f.repo, f.co, f.run, 'zz').status, 2);
  assert.ok(fs.existsSync(partsRoot()));
  fs.rmSync(logsDir(f.repo, f.run), { recursive: true, force: true });
  f.cleanup();
});
