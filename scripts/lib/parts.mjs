// Runs a repo's CI checks on this machine in the parts its recipe names
// (<repo>/.first-pass/parts.json): stages in order, the parts of a stage side by side, each with
// its own logs, its own port and its run's own resources ({{run}} in a database name), so a full
// local run takes as long as its slowest stage instead of the sum of its parts.
//
// The recipe is read from the repo the session works in, never from the checkout under test, so
// a change being tested cannot change what runs; env files with local keys live there too.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const RECIPE_PATH = path.join('.first-pass', 'parts.json');
const WIN = process.platform === 'win32';
const RUN_NAME = /^[a-z0-9]+$/;
const PART_NAME = /^[a-z0-9][a-z0-9-]*$/;
// The server probe stays on this machine (the plugin's scripts make no network call).
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+|:\{\{port\}\})?(\/|$)/;
const VARS = ['run', 'shard', 'shards', 'port', 'checkout', 'repo', 'logs'];
const WRAPPER_VARS = ['name', 'memoryGB', 'timeoutMin', 'logs', 'repo', 'checkout', 'command', 'commandFile'];

export class PartsError extends Error {}

// Every field the recipe may hold: a misspelt one ("requried") is refused, never ignored.
const FIELDS = {
  recipe: ['firstPassParts', 'stages', 'parts', '$comment'],
  part: ['steps', 'cleanup', 'shards', 'needs', 'inputs', 'env', 'envFile', 'files', 'server', 'cwd', 'memoryGB', 'timeoutMin', '$comment'],
  step: ['name', 'run', 'cwd', 'env', 'required', 'ran', 'summary'],
  server: ['run', 'cwd', 'env', 'ready', 'url', 'ports', 'timeoutSec'],
  envFile: ['path', 'keys'],
};

function onlyFields(where, value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PartsError(`${where} is an object`);
  const bad = Object.keys(value).find((k) => !FIELDS[kind].includes(k));
  if (bad) throw new PartsError(`${where}: "${bad}" is not a field (${FIELDS[kind].filter((k) => k !== '$comment').join(', ')})`);
}

function textMap(where, value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) throw new PartsError(`${where} maps names to text`);
}

const placeholders = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

export function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (all, name) => {
    if (vars[name] === undefined || vars[name] === null) throw new PartsError(`{{${name}}} has no value here`);
    return String(vars[name]);
  });
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(k, out), strings(v, out);
  return out;
}

function checkSteps(where, steps, required) {
  if (!Array.isArray(steps) || (required && !steps.length)) throw new PartsError(`${where} needs a list of steps`);
  for (const step of steps) {
    onlyFields(`${where} step`, step, 'step');
    textMap(`${where} step ${step.name} "env"`, step.env);
    if (step.required !== undefined && typeof step.required !== 'boolean') throw new PartsError(`${where}: step ${step.name} "required" is true or false`);
    if (typeof step.name !== 'string' || !PART_NAME.test(step.name)) throw new PartsError(`${where}: every step needs a name of lowercase letters, digits and dashes`);
    if (typeof step.run !== 'string' || !step.run.trim()) throw new PartsError(`${where}: step ${step.name} needs "run"`);
    for (const key of ['ran', 'summary']) {
      if (step[key] === undefined) continue;
      try {
        new RegExp(step[key], 'm');
      } catch (error) {
        throw new PartsError(`${where}: step ${step.name} "${key}" is not a regex: ${error.message}`);
      }
    }
  }
}

// Reads and checks the recipe; shards expand to <name>-1 .. <name>-n.
export function loadRecipe(repo) {
  const file = path.join(repo, RECIPE_PATH);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PartsError(`${file}: ${error.message}`);
  }
  if (raw.firstPassParts !== 1 || !raw.parts || typeof raw.parts !== 'object' || !Array.isArray(raw.stages)) {
    throw new PartsError(`${file} needs "firstPassParts": 1, "parts" and "stages"`);
  }
  onlyFields(file, raw, 'recipe');
  const parts = new Map();
  const groups = new Map();
  for (const [name, def] of Object.entries(raw.parts)) {
    if (!PART_NAME.test(name)) throw new PartsError(`${file}: part "${name}" needs a name of lowercase letters, digits and dashes`);
    onlyFields(`part ${name}`, def, 'part');
    textMap(`part ${name} "env"`, def.env);
    textMap(`part ${name} "files"`, def.files);
    if (def.server) {
      onlyFields(`part ${name} server`, def.server, 'server');
      textMap(`part ${name} server "env"`, def.server.env);
    }
    if (def.envFile) onlyFields(`part ${name} envFile`, def.envFile, 'envFile');
    checkSteps(`part ${name}`, def.steps, true);
    checkSteps(`part ${name} cleanup`, def.cleanup ?? [], false);
    const shards = def.shards ?? 0;
    if (!Number.isInteger(shards) || shards < 0) throw new PartsError(`part ${name}: "shards" is a whole number`);
    for (const key of ['memoryGB', 'timeoutMin']) {
      if (def[key] !== undefined && !(typeof def[key] === 'number' && def[key] > 0)) throw new PartsError(`part ${name}: "${key}" is a number above 0`);
    }
    if (def.server) {
      const s = def.server;
      if (typeof s.run !== 'string' || typeof s.ready !== 'string' || typeof s.url !== 'string') throw new PartsError(`part ${name}: the server needs "run", "ready" and "url"`);
      if (!LOCAL_URL.test(s.url)) throw new PartsError(`part ${name}: the server url must be on this machine (http://127.0.0.1, localhost or [::1])`);
      const [lo, hi] = s.ports ?? [];
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1024 || hi > 65535 || lo > hi) throw new PartsError(`part ${name}: the server needs "ports": [low, high] between 1024 and 65535`);
    }
    if (def.envFile && (typeof def.envFile.path !== 'string' || !Array.isArray(def.envFile.keys) || !def.envFile.keys.length)) {
      throw new PartsError(`part ${name}: "envFile" needs a "path" and a list of "keys"`);
    }
    if (def.inputs !== undefined && (!Array.isArray(def.inputs) || def.inputs.some((p) => typeof p !== 'string'))) throw new PartsError(`part ${name}: "inputs" is a list of paths`);
    const known = new Set(['run', 'checkout', 'repo', 'logs', ...(shards ? ['shard', 'shards'] : []), ...(def.server ? ['port'] : [])]);
    for (const text of strings(def)) {
      for (const p of placeholders(text)) {
        if (!VARS.includes(p)) throw new PartsError(`part ${name}: {{${p}}} is not a placeholder (${VARS.join(', ')})`);
        if (!known.has(p)) throw new PartsError(`part ${name}: {{${p}}} has no value in this part`);
      }
    }
    const names = shards ? Array.from({ length: shards }, (_, i) => `${name}-${i + 1}`) : [name];
    names.forEach((n, i) => {
      if (parts.has(n)) throw new PartsError(`${file}: two parts are named ${n}`);
      parts.set(n, { ...def, name: n, group: name, shard: shards ? i + 1 : null, shards: shards || null });
    });
    groups.set(name, names);
  }
  const expand = (n, where) => {
    if (groups.has(n)) return groups.get(n);
    if (parts.has(n)) return [n];
    throw new PartsError(`${where} names "${n}", which is not a part`);
  };
  for (const part of parts.values()) part.needs = (part.needs ?? []).flatMap((n) => expand(n, `part ${part.name} "needs"`));
  const stages = raw.stages.map((stage, i) => {
    if (!Array.isArray(stage)) throw new PartsError(`${file}: stage ${i + 1} is a list of part names`);
    return stage.flatMap((n) => expand(n, `stage ${i + 1}`));
  });
  const placed = stages.flat();
  for (const n of parts.keys()) {
    const count = placed.filter((p) => p === n).length;
    if (count !== 1) throw new PartsError(`${file}: part ${n} is in ${count} stages (each part goes in exactly one)`);
  }
  for (const part of parts.values()) {
    const at = stages.findIndex((s) => s.includes(part.name));
    for (const dep of part.needs) {
      if (stages.findIndex((s) => s.includes(dep)) >= at) throw new PartsError(`part ${part.name} needs ${dep}, which must be in an earlier stage`);
    }
  }
  return { file, parts, stages, groups, expand };
}

// The part and every part it needs, directly or through others.
function allNeeds(recipe, part, seen = new Set()) {
  for (const dep of part.needs) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    allNeeds(recipe, recipe.parts.get(dep), seen);
  }
  return [...seen];
}

export function canonical(p) {
  const real = fs.realpathSync.native(p);
  return WIN ? real.toLowerCase() : real;
}

// On Linux and macOS the temp folder can be shared with other accounts, and what the runner keeps
// in its folder is run as this user: the folder is this user's alone, or it is refused.
export function partsRoot() {
  const root = path.join(os.tmpdir(), 'first-pass-parts');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!WIN) {
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.uid !== process.getuid()) throw new PartsError(`${root} is not a folder of this user's own: remove it, or set TMPDIR to one`);
    if (st.mode & 0o022) throw new PartsError(`${root} is a folder others can write to: chmod 700 it, or remove it`);
  }
  return root;
}

export function logsDir(repo, run) {
  const id = crypto.createHash('sha1').update(canonical(repo)).digest('hex').slice(0, 8);
  return path.join(partsRoot(), `${path.basename(repo)}-${id}`, run);
}

// A run name belongs to the first checkout that used it: another checkout reusing the name would
// share its databases and trust its marks.
export function claimRun(logs, checkout) {
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'checkout');
  const mine = canonical(checkout);
  try {
    fs.writeFileSync(file, mine, { flag: 'wx' });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const owner = fs.readFileSync(file, 'utf8');
  if (owner !== mine) throw new PartsError(`run name ${path.basename(logs)} belongs to ${owner || 'a run still starting'}: pick another`);
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// An exclusive lock file holding the owner's pid; one whose owner is gone is taken over. Two runs
// can both hold one (see INVARIANTS 12's known breaks).
// On Windows a file another process is removing answers EPERM until it is gone.
const vanishing = (error) => error.code === 'ENOENT' || (WIN && error.code === 'EPERM');

function removeLock(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    if (!vanishing(error)) throw error;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lock(file) {
  for (let i = 0; i < 10; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (error) {
      // Being removed: it is gone in moments. Ten tries in a row is a real permission problem.
      if (WIN && error.code === 'EPERM' && i < 9) {
        pause(5 + Math.floor(Math.random() * 45));
        continue;
      }
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readLock(file);
    if (owner === null) continue; // released between the create and the read: try again
    if (alive(owner)) return false;
    removeLock(file);
  }
  return false;
}

function readLock(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (vanishing(error)) return null;
    throw error;
  }
}

export function unlock(file) {
  if (readLock(file) === process.pid) removeLock(file);
}

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (yes) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(!['EADDRINUSE', 'EACCES'].includes(error.code)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function portFree(port) {
  if (await answers(port)) return false;
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::'));
}

// The first port in the range that is free and not held by another run on this machine.
export async function takePort([lo, hi]) {
  const dir = path.join(partsRoot(), 'ports');
  fs.mkdirSync(dir, { recursive: true });
  for (let port = lo; port <= hi; port++) {
    const file = path.join(dir, `${port}.lock`);
    if (!lock(file)) continue;
    if (await portFree(port)) return { port, file };
    unlock(file);
  }
  return null;
}

// The inputs' contents by git's file list: a copy that keeps an old file time, or a deleted
// file, still counts as a change.
export function inputsHash(checkout, inputs) {
  if (!inputs?.length) return 'no inputs';
  const r = spawnSync('git', ['-C', checkout, 'ls-files', '-co', '--exclude-standard', '-z', '--', ...inputs], { maxBuffer: 1 << 28 });
  if (r.error) throw new PartsError(`git is needed to read the inputs: ${r.error.message}`);
  if (r.status !== 0) throw new PartsError(`git ls-files failed in ${checkout}: ${String(r.stderr).trim()}`);
  const files = r.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) {
    let data;
    try {
      data = fs.readFileSync(path.join(checkout, f));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'EISDIR') data = Buffer.from('dir');
      else throw error;
    }
    hash.update(f).update('\0').update(crypto.createHash('sha1').update(data).digest()).update('\0');
  }
  return hash.digest('hex');
}

// The named keys from a dotenv file in the repo; values are never printed.
export function readEnvFile(repo, spec) {
  const file = path.resolve(repo, spec.path);
  if (!fs.existsSync(file)) throw new PartsError(`${spec.path} is missing (it holds ${spec.keys.join(', ')})`);
  const found = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !spec.keys.includes(m[1]) || Object.hasOwn(found, m[1])) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    found[m[1]] = value;
  }
  const missing = spec.keys.filter((k) => !found[k]);
  if (missing.length) throw new PartsError(`${spec.path} has no value for ${missing.join(', ')}`);
  return found;
}

function start(command, { cwd, env, log }) {
  const fd = fs.openSync(log, 'a');
  const child = spawn(command, { shell: true, cwd, env, stdio: ['ignore', fd, fd], detached: !WIN, windowsHide: true });
  fs.closeSync(fd);
  child.done = new Promise((resolve) => {
    child.once('error', (error) => {
      fs.appendFileSync(log, `\n[first-pass parts] could not start: ${error.message}\n`);
      resolve({ code: -1, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return child;
}

const running = (child) => child.exitCode === null && child.signalCode === null;

// Stops the process and everything it started, by its own OS pid. On Windows a pid whose
// process already ended may belong to another program by now, so only a running one is killed.
export async function stopTree(child) {
  if (!child.pid) return; // it never started
  if (WIN) {
    if (running(child)) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      if (signal === 'SIGTERM') await Promise.race([child.done, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
  await Promise.race([child.done, new Promise((r) => setTimeout(r, 10000))]);
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readIf = readMark;

// A mark half written, or removed by a rerun just as it is read, is no mark.
export function readMark(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || vanishing(error)) return null;
    throw error;
  }
}

async function released(port) {
  for (let i = 0; i < 10; i++) {
    if (!(await answers(port))) return true;
    await sleep(500);
  }
  return false;
}

export class Runner {
  constructor({ repo, checkout, run, recipe, wrapper = null, cli = null, out = (line) => console.log(line) }) {
    if (!RUN_NAME.test(run)) throw new PartsError('the run name is lowercase letters and digits (it goes into database names)');
    if (!fs.existsSync(checkout)) throw new PartsError(`${checkout} does not exist`);
    if (canonical(checkout) === canonical(repo)) throw new PartsError(`run it on a clean checkout, not the tree you work in (${repo})`);
    Object.assign(this, { repo: path.resolve(repo), checkout: path.resolve(checkout), run, recipe, wrapper, cli, out });
    this.logs = logsDir(repo, run);
    claimRun(this.logs, checkout);
    this.active = new Set();
    this.stopping = false;
    this.inner = false;
    this.stopFile = path.join(this.logs, 'stop');
  }

  note(line) {
    const text = `${line} ${new Date().toTimeString().slice(0, 8)}`;
    fs.appendFileSync(path.join(this.logs, 'summary.txt'), text + '\n');
    this.out(text);
  }

  markFile(name) {
    return path.join(this.logs, 'marks', `${name}.json`);
  }

  // Why the part cannot run yet (a part it needs has not passed on this checkout, or its inputs
  // changed since), and the pass of every part it needs, directly or through others, as read for
  // that check: the part's result stands only if those are still the latest when it ends.
  notReady(part) {
    const needs = allNeeds(this.recipe, part);
    // Every mark read once, so each check and what the part watches come from one snapshot.
    const marks = Object.fromEntries(needs.map((dep) => [dep, readMark(this.markFile(dep))]));
    const seen = {};
    for (const dep of needs) {
      const mark = marks[dep];
      if (!mark) return { why: `it needs ${dep}, which has not passed on this checkout: run ${dep} first`, seen };
      if (mark.hash !== inputsHash(this.checkout, this.recipe.parts.get(dep).inputs)) return { why: `${dep}'s inputs changed since it passed: run ${dep} again`, seen };
      // A part rerun after this one passed (a new install) makes this one's result stale too.
      for (const [up, at] of Object.entries(mark.deps ?? {})) {
        const now = marks[up];
        if (now && now.at !== at) return { why: `${dep} passed before ${up}'s latest pass: run ${dep} again`, seen };
      }
      seen[dep] = mark.at;
    }
    return { why: null, seen };
  }

  // Written after the part passed, whole or not at all; the hash and deps are as they were when
  // it started.
  writeMark(part, hash, deps) {
    const file = this.markFile(part.name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ hash, at: new Date().toISOString(), deps }));
    fs.renameSync(`${file}.tmp`, file);
  }

  leftoverFile(name) {
    return path.join(this.logs, `${name}.leftover.json`);
  }

  baseVars(part) {
    return { run: this.run, checkout: this.checkout, repo: this.repo, logs: this.logs, shard: part.shard, shards: part.shards, port: null };
  }

  // What an earlier run of this part left when it was killed before its own cleanup: its files and
  // its cleanup steps. Every value is this run's own; the record gives only the earlier run's
  // port, taken when it is a port of this part's range. A file is removed only at a path this
  // part writes and while it holds exactly what this part writes there. Env file values are read
  // again, never kept on disk.
  async recover(part, record) {
    this.note(`${part.name}: cleaning up after an earlier run of it that stopped before its cleanup`);
    const vars = this.baseVars(part);
    const [lo, hi] = part.server?.ports ?? [];
    if (part.server && Number.isInteger(record.port) && record.port >= lo && record.port <= hi) vars.port = record.port;
    const skip = (what, error) => {
      if (!(error instanceof PartsError)) throw error;
      this.note(`${part.name}: the earlier run's ${what} was skipped: ${error.message}`);
    };
    for (const [rel, text] of Object.entries(part.files ?? {})) {
      let file, content;
      try {
        file = path.resolve(this.checkout, fill(rel, vars));
        content = fill(text, vars);
      } catch (error) {
        skip(`file ${rel}`, error);
        continue;
      }
      if (!fs.existsSync(file)) continue;
      if (fs.readFileSync(file, 'utf8') === content) fs.rmSync(file, { force: true });
      else this.note(`${part.name}: ${file} is not what the runner writes there, so it was left alone`);
    }
    let env = null;
    try {
      env = this.partEnv(part, vars);
    } catch (error) {
      skip('cleanup', error);
    }
    for (const step of env ? (part.cleanup ?? []) : []) {
      try {
        const result = await this.exec(part, step, vars, env, Date.now() + 5 * 60000, 'cleanup ');
        if (!result.ok) this.note(`${part.name}: cleanup ${step.name} failed (see ${part.name}-${step.name}.log)`);
      } catch (error) {
        skip(`cleanup ${step.name}`, error);
      }
    }
    fs.rmSync(this.leftoverFile(part.name), { force: true });
  }

  partEnv(part, vars) {
    return { ...process.env, ...(part.envFile ? readEnvFile(this.repo, part.envFile) : {}), ...this.fillEnv(part.env, vars) };
  }

  async exec(part, step, vars, env, deadline, kind) {
    const log = path.join(this.logs, `${part.name}-${step.name}.log`);
    fs.writeFileSync(log, '');
    const started = Date.now();
    const child = start(fill(step.run, vars), { cwd: path.resolve(this.checkout, fill(step.cwd ?? part.cwd ?? '.', vars)), env: { ...env, ...this.fillEnv(step.env, vars) }, log });
    this.active.add(child);
    const left = deadline - Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child).catch((error) => this.note(`${part.name}: could not stop ${step.name}: ${error.message}`));
    }, Math.max(left, 0));
    const { code } = await child.done;
    clearTimeout(timer);
    this.active.delete(child);
    const seconds = Math.round((Date.now() - started) / 1000);
    let ok = code === 0 && !timedOut;
    this.note(`${part.name} ${kind}${step.name} exit=${code}${timedOut ? ' TIMED OUT' : ''} seconds=${seconds}`);
    const text = fs.readFileSync(log, 'utf8');
    if (step.ran && !new RegExp(step.ran, 'm').test(text)) {
      this.note(`${part.name} ${step.name} ran no tests (its log has no line matching /${step.ran}/)`);
      ok = false;
    }
    if (step.summary) {
      const lines = text.split(/\r?\n/).filter((l) => new RegExp(step.summary).test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
      if (lines.length) this.note(`${part.name} ${step.name} result: ${lines.slice(-6).join(', ')}`);
    }
    return { ok, timedOut };
  }

  fillEnv(env, vars) {
    return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, fill(String(v), vars)]));
  }

  async startServer(part, vars, env, deadline) {
    const s = part.server;
    const log = path.join(this.logs, `${part.name}-server.log`);
    fs.writeFileSync(log, '');
    const child = start(fill(s.run, vars), { cwd: path.resolve(this.checkout, fill(s.cwd ?? part.cwd ?? '.', vars)), env: { ...env, ...this.fillEnv(s.env, vars) }, log });
    this.active.add(child);
    const url = fill(s.url, vars);
    const ready = new RegExp(s.ready, 'm');
    const until = Math.min(deadline, Date.now() + (s.timeoutSec ?? 300) * 1000);
    // Only this part's own server counts: its process still running, its own log saying ready,
    // and the url answering. Anything else on the url is not it.
    while (Date.now() < until && !this.stopping) {
      if (!running(child)) break;
      if (ready.test(fs.readFileSync(log, 'utf8')) && (await get(url))) return child;
      await sleep(1000);
    }
    await stopTree(child);
    this.active.delete(child);
    return null;
  }

  async runPart(part) {
    this.note(`=== ${part.name} start (checkout ${this.checkout}, run ${this.run})`);
    fs.mkdirSync(path.join(this.logs, 'marks'), { recursive: true });
    const partLock = path.join(this.logs, `${part.name}.lock`);
    if (!lock(partLock)) {
      this.note(`=== ${part.name} FAILED: it is already running in this run`);
      return false;
    }
    const deadline = Date.now() + (part.timeoutMin ?? 30) * 60000;
    const written = [];
    let server = null;
    let port = null;
    let ok = true;
    let env = null;
    let hash = null;
    let deps = null;
    let watched = null;
    const vars = this.baseVars(part);
    // A rerun that fails must not leave the last pass's mark for the parts that need this one.
    fs.rmSync(this.markFile(part.name), { force: true });
    const leftover = this.leftoverFile(part.name);
    try {
      const earlier = readIf(leftover);
      if (earlier) await this.recover(part, earlier);
      const { why, seen } = this.notReady(part);
      if (why) throw new PartsError(why);
      watched = seen;
      deps = Object.fromEntries(part.needs.map((d) => [d, seen[d]]));
      hash = inputsHash(this.checkout, part.inputs);
      if (part.server) {
        port = await takePort(part.server.ports);
        if (!port) throw new PartsError(`no free port from ${part.server.ports[0]} to ${part.server.ports[1]}`);
        vars.port = port.port;
      }
      env = this.partEnv(part, vars);
      // Kept until the cleanup has run, so the next run of this part can clean up after this one.
      fs.writeFileSync(leftover, JSON.stringify({ port: vars.port }));
      for (const [rel, text] of Object.entries(part.files ?? {})) {
        const file = path.resolve(this.checkout, fill(rel, vars));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, fill(text, vars), { flag: 'wx' });
        written.push(file);
      }
      if (part.server) {
        server = await this.startServer(part, vars, env, deadline);
        if (!server) throw new PartsError(`its server did not start on port ${vars.port} (see ${part.name}-server.log)`);
      }
      for (const step of part.steps) {
        if (this.stopping) throw new PartsError('stopped');
        const result = await this.exec(part, step, vars, env, deadline, '');
        if (!result.ok) ok = false;
        if (result.timedOut) throw new PartsError(`it ran past its ${part.timeoutMin ?? 30} minutes`);
        if (!result.ok && step.required) throw new PartsError(`${step.name} failed, and the rest of the part needs it`);
      }
    } catch (error) {
      if (!(error instanceof PartsError) && error.code !== 'EEXIST') throw error;
      this.note(`${part.name}: ${error.code === 'EEXIST' ? `${error.path} already exists, and the part writes it` : error.message}`);
      ok = false;
    } finally {
      if (server) {
        await stopTree(server);
        this.active.delete(server);
        if (!(await released(vars.port))) this.note(`${part.name}: port ${vars.port} is still in use after stopping its server`);
      }
      for (const file of written) fs.rmSync(file, { force: true });
      if (port) unlock(port.file);
      if (env) {
        for (const step of part.cleanup ?? []) {
          const result = await this.exec(part, step, vars, env, Date.now() + 5 * 60000, 'cleanup ');
          if (!result.ok) this.note(`${part.name}: cleanup ${step.name} failed (see ${part.name}-${step.name}.log)`);
        }
      }
      fs.rmSync(leftover, { force: true });
      unlock(partLock);
    }
    if (ok && !this.stopping) {
      // A part it needs, directly or not, run again while this one ran (or still running) leaves
      // this result stale.
      const rerun = Object.keys(watched).find((dep) => readMark(this.markFile(dep))?.at !== watched[dep]);
      if (rerun) {
        this.note(`${part.name}: ${rerun}, which it needs, was run again while it ran: run ${part.name} again`);
        ok = false;
      } else this.writeMark(part, hash, deps);
    }
    this.note(`=== ${part.name} ${ok && !this.stopping ? 'passed' : 'FAILED'}`);
    return ok;
  }

  // One part through the machine's wrapper (a memory cap, say): the wrapper runs this command
  // again for that part alone. It passed only when that run wrote its mark: a wrapper that exits
  // 0 without running it (a moved script, a wrong argument) is not a pass.
  async runWrapped(part) {
    fs.mkdirSync(path.join(this.logs, 'marks'), { recursive: true });
    fs.rmSync(this.markFile(part.name), { force: true });
    const command = [process.execPath, this.cli, 'parts', this.repo, this.checkout, this.run, part.name, '--inner'].map((a) => `"${a.replace(/\\/g, '/')}"`).join(' ');
    const commandFile = path.join(this.logs, `${part.name}.command`);
    fs.writeFileSync(commandFile, command + '\n');
    const vars = { name: part.name, memoryGB: part.memoryGB ?? 4, timeoutMin: (part.timeoutMin ?? 30) + 5, logs: this.logs, repo: this.repo, checkout: this.checkout, command, commandFile };
    const [exe, ...args] = this.wrapper.map((a) => fill(a, vars));
    const log = path.join(this.logs, `${part.name}-wrapper.log`);
    fs.writeFileSync(log, '');
    const fd = fs.openSync(log, 'a');
    const child = spawn(exe, args, { stdio: ['ignore', fd, fd], detached: !WIN, windowsHide: true });
    fs.closeSync(fd);
    child.done = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: -1, error }));
      child.once('exit', (code) => resolve({ code }));
    });
    this.active.add(child);
    const { code, error } = await child.done;
    this.active.delete(child);
    if (error) this.note(`${part.name}: the wrapper could not start: ${error.message}`);
    this.note(`${part.name} through the wrapper exit=${code} (see ${part.name}-wrapper.log)`);
    const passed = code === 0 && readIf(this.markFile(part.name)) !== null;
    if (code === 0 && !passed) this.note(`${part.name}: the wrapper exited 0 but the part never passed (no mark): check the wrapper and ${part.name}-wrapper.log`);
    return passed;
  }

  // Runs the named parts, stage by stage, those of a stage side by side.
  async runParts(names, { inner = false } = {}) {
    this.inner = inner;
    const chosen = new Set(names);
    let ok = true;
    // A wrapped run is asked to stop through a file, so it stops its own steps and cleans up.
    const poll = inner ? setInterval(() => fs.existsSync(this.stopFile) && this.stopAll(), 1000) : null;
    if (!inner) {
      fs.rmSync(this.stopFile, { force: true });
      this.note(`logs: ${this.logs}`);
    }
    try {
      for (const stage of this.recipe.stages) {
        const now = stage.filter((n) => chosen.has(n));
        if (!now.length || this.stopping) continue;
        const results = await Promise.all(now.map((n) => (this.wrapper && !inner ? this.runWrapped(this.recipe.parts.get(n)) : this.runPart(this.recipe.parts.get(n)))));
        if (results.includes(false)) ok = false;
      }
    } finally {
      if (poll) clearInterval(poll);
    }
    if (!inner) this.note(`=== ${ok && !this.stopping ? 'every part passed' : 'FAILED'}; summary.txt and each step's log are in ${this.logs}`);
    return ok && !this.stopping;
  }

  async stopAll() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.wrapper && !this.inner) {
      // Wrapped runs stop themselves and clean up; one still running after a minute is killed,
      // and the next run of that part cleans up after it.
      fs.writeFileSync(this.stopFile, String(process.pid));
      await Promise.race([Promise.all([...this.active].map((child) => child.done)), sleep(60000)]);
    }
    await Promise.all([...this.active].map((child) => stopTree(child)));
  }
}

export function checkWrapper(wrapper) {
  if (!Array.isArray(wrapper) || !wrapper.length || wrapper.some((a) => typeof a !== 'string')) throw new PartsError('"partWrapper" is a list of strings: the program, then its arguments');
  const used = wrapper.flatMap(placeholders);
  const bad = used.filter((p) => !WRAPPER_VARS.includes(p));
  if (bad.length) throw new PartsError(`"partWrapper": {{${bad[0]}}} is not a placeholder (${WRAPPER_VARS.join(', ')})`);
  if (!used.includes('command') && !used.includes('commandFile')) throw new PartsError('"partWrapper" must pass {{command}} or {{commandFile}}');
  return wrapper;
}

export function describe(recipe) {
  return recipe.stages
    .map((stage, i) => `stage ${i + 1}: ${stage.map((n) => {
      const p = recipe.parts.get(n);
      const bits = [p.needs.length && `needs ${p.needs.join(', ')}`, p.server && `server on ${p.server.ports.join('-')}`, `${p.memoryGB ?? 4} GB`, `${p.timeoutMin ?? 30} min`].filter(Boolean);
      return `${n} (${bits.join(', ')})`;
    }).join(', ')}`)
    .join('\n');
}
