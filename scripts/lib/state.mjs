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
    const newest = Math.max(
      fs.statSync(dir).mtimeMs,
      ...fs.readdirSync(dir).map((name) => fs.statSync(path.join(dir, name)).mtimeMs),
    );
    if (newest < cutoff) fs.rmSync(dir, { recursive: true, force: true });
  }
}
