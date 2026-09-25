// Per-session state, kept in the plugin's data folder (CLAUDE_PLUGIN_DATA survives plugin
// updates). Edits are appended one JSON line each, so hooks running in parallel for
// parallel edits never overwrite each other.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'first-pass');
}

function sessionDir(sessionId) {
  return path.join(dataDir(), 'sessions', String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_'));
}

export function appendEdit(sessionId, record) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'edits.jsonl'), JSON.stringify(record) + '\n');
}

export function readEdits(sessionId) {
  const file = path.join(sessionDir(sessionId), 'edits.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// How many edit lines a named consumer (one per Stop hook) has already handled.
export function readOffset(sessionId, name) {
  const file = path.join(sessionDir(sessionId), `offset-${name}`);
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
}

export function writeOffset(sessionId, name, offset) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `offset-${name}`), String(offset));
}

// A small named JSON record for the session, or null when none was written.
export function readRecord(sessionId, name) {
  const file = path.join(sessionDir(sessionId), `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function writeRecord(sessionId, name, value) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  if (value === null) return fs.rmSync(file, { force: true });
  // Written whole, then renamed: a half-written record would make every later hook in the
  // session fail on it, repo hooks included.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(temp, file);
    } catch (error) {
      // Windows refuses a rename onto a file another hook has open for a moment.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5);
    }
  }
}

// True the first time `name` is raised in a session, false after: for notices that should
// appear once per session, not on every tool call.
export function firstTime(sessionId, name) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `once-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`), '', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function removeOldSessions(maxAgeDays = 7) {
  const root = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    // Appending to a file does not touch its folder's mtime, so age is the newest file's.
    // A live session renames and deletes its own files while this runs, so one can vanish
    // between the listing and the stat.
    const names = listing(dir);
    if (names === null) continue;
    const newest = Math.max(mtime(dir), ...names.map((name) => mtime(path.join(dir, name))));
    if (newest < cutoff) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const VANISHED = new Set(['ENOENT', 'EPERM']);

function listing(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (VANISHED.has(error.code)) return null;
    throw error;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (error) {
    if (VANISHED.has(error.code)) return 0;
    throw error;
  }
}
