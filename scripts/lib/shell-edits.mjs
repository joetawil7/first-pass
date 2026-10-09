// Files a shell command changed. The edit tools name their file; a shell command (`sed -i`,
// a heredoc, a formatter, a script) does not. So the first shell command that can reach a
// repo notes its `git status`, each shell run is logged from PreToolUse to its PostToolUse,
// and at Stop a file changed since the note whose modification time falls inside a run is
// recorded as an edit of that run's prompt. Changes made outside every run (the user's
// editor, another session, a `git reset` that rewrites nothing) are left out.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commandTarget } from './bridge.mjs';
import { gitRoot, isInside, isNetworkPath, pathKey, relative, resolveShellPath } from './paths.mjs';
import { appendLine, createRecord, hasRecord, readLines, readRecord, recordNames, writeRecord } from './state.mjs';
import { repoOf } from './workspace.mjs';

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// All git calls in one hook run share this, so first-pass still answers inside the margin
// bridge.mjs leaves before Claude Code's limit.
export const GIT_BUDGET_MS = 3000;
// A file's time and the clock can differ by the filesystem's time resolution.
const SLACK_MS = 2000;
// A run with no end logged (another hook denied it, or the session died) ends at the
// tool's own timeout.
const DEFAULT_RUN_MS = 120_000;
const MAX_RUN_MS = 600_000;
const MAX_WORDS = 64;
const RUNS = 'shell-runs';
const NOTE = 'shell-note-';

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const noteName = (root) => `${NOTE}${hash(pathKey(root))}`;
const brokenName = (promptId, root) => `shell-broken-${hash(String(promptId))}-${hash(pathKey(root))}`;

function gitRootOf(place, stopAt) {
  try {
    return gitRoot(place, stopAt);
  } catch (error) {
    // A place the filesystem refuses to describe holds no repo first-pass can read.
    if (error.code) return null;
    throw error;
  }
}

// The repos a shell command may write to: where it runs, the folder it names with
// `cd`/`git -C`, and, from a main folder, any path in it that lies inside that folder.
// Words are compared as text first, so no path outside the main folder is ever looked up.
export function shellRoots(input, ws) {
  const cwd = input.cwd ?? process.cwd();
  const places = [cwd, commandTarget(input)];
  if (ws) {
    let count = 0;
    for (const m of String(input.tool_input?.command ?? '').matchAll(/"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+)/g)) {
      const word = m[1] ?? m[2] ?? m[3];
      if (!/[\\/]/.test(word) || word.startsWith('-') || isNetworkPath(word) || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue;
      const target = resolveShellPath(cwd, word, input.tool_name);
      if (isInside(target, ws.root)) places.push(target);
      if (++count >= MAX_WORDS) break;
    }
  }
  const roots = new Map();
  for (const place of places) {
    if (!place || isNetworkPath(place)) continue;
    const repo = ws ? repoOf(ws, place) : null;
    const root = gitRootOf(place, repo?.abs ?? ws?.root);
    if (root && !roots.has(pathKey(root))) roots.set(pathKey(root), root);
  }
  return [...roots.values()];
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // A file another program holds can refuse a stat on Windows; it counts as unchanged.
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return 'unreadable';
    throw error;
  }
}

function signature(file) {
  const s = stat(file);
  return s === null ? 'gone' : s === 'unreadable' ? s : `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
}

// When a file was last written. `cp -p` keeps the source's mtime but not its ctime; a copy
// to a new file gets a new birthtime. A deleted file has no time left, so it takes the time
// of the nearest folder above it that is still there.
function writtenAt(file, root) {
  for (let place = file; ; place = path.dirname(place)) {
    const s = stat(place);
    if (s && s !== 'unreadable') return Math.max(s.mtimeMs, s.ctimeMs, s.birthtimeMs || 0);
    if (s === 'unreadable' || pathKey(place) === pathKey(root) || path.dirname(place) === place) return null;
  }
}

// Each changed or untracked file in the repo, with its mtime and size, or why git gave none.
export function changedFiles(root, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { error: 'first-pass ran out of time for git status' };
  const args = ['-C', root, '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
  const result = spawnSync('git', args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) return { error: result.error.code === 'ETIMEDOUT' ? 'git status took too long' : result.error.message };
  if (result.status !== 0) return { error: `git status failed: ${String(result.stderr).trim().split('\n')[0]}` };
  const files = {};
  for (const entry of result.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const rel = entry.slice(3);
    files[rel] = signature(path.join(root, rel));
  }
  return { files };
}

// Said once per repo per session, so a repo git cannot read does not look like one with no changes.
function unreadable(root, error) {
  return {
    name: 'first-pass shell edits',
    own: true,
    once: `shell-unreadable-${hash(pathKey(root))}`,
    json: { systemMessage: `first-pass: could not read git status in ${root} (${error}), so files a shell command changed there are not seen by the done check or end-of-turn hooks.` },
  };
}

// PreToolUse, for a shell command: note each repo it can reach that has no note yet, and
// log the start of the run.
export function noteShellStart(input, ws, deadline = Date.now() + GIT_BUDGET_MS) {
  if (!SHELL_TOOLS.has(input.tool_name)) return [];
  const sessionId = input.session_id;
  const start = Date.now();
  const notices = [];
  for (const root of shellRoots(input, ws)) {
    // A repo git failed on is tried again next prompt, not on every command of this one.
    if (hasRecord(sessionId, noteName(root)) || hasRecord(sessionId, brokenName(input.prompt_id, root))) continue;
    const { files, error } = changedFiles(root, deadline);
    if (error) {
      createRecord(sessionId, brokenName(input.prompt_id, root), { root, error });
      notices.push(unreadable(root, error));
    } else {
      // A parallel command may have noted it first; the earlier note is the one to keep.
      createRecord(sessionId, noteName(root), { root, at: start, files });
    }
  }
  const limit = Math.min(Number(input.tool_input?.timeout) || DEFAULT_RUN_MS, MAX_RUN_MS);
  appendLine(sessionId, RUNS, { id: input.tool_use_id ?? null, prompt: input.prompt_id ?? null, start, until: start + limit });
  return notices;
}

// PostToolUse or PostToolUseFailure for a shell command, or a PreToolUse that denied it.
export function noteShellEnd(input) {
  if (SHELL_TOOLS.has(input.tool_name) && input.tool_use_id) appendLine(input.session_id, RUNS, { id: input.tool_use_id, end: Date.now() });
  return [];
}

// UserPromptSubmit. A command refused at the permission prompt gets no PostToolUse, so a run
// with no end logged ends at the next prompt at the latest.
export function noteShellPrompt(input) {
  appendLine(input.session_id, RUNS, { prompt: input.prompt_id ?? null, promptAt: Date.now() });
  return [];
}

// Each logged run as the span of time its writes can carry.
function runs(sessionId, now) {
  const ends = new Map();
  const prompts = [];
  const starts = [];
  for (const line of readLines(sessionId, RUNS)) {
    if ('end' in line) ends.set(line.id, line.end);
    else if ('promptAt' in line) prompts.push(line.promptAt);
    else starts.push(line);
  }
  return starts.map((run) => {
    const next = prompts.find((at) => at > run.start) ?? Infinity;
    return {
      prompt: run.prompt,
      from: run.start - SLACK_MS,
      to: ((run.id !== null && ends.get(run.id)) || Math.min(run.until, next, now)) + SLACK_MS,
    };
  });
}

// Stop: record each file changed since its repo's note inside a shell run as an edit of
// that run's prompt, then move the note to now, so a change after a send-back is seen at
// the next Stop.
export function recordShellEdits(input, ws, append, deadline = Date.now() + GIT_BUDGET_MS) {
  const sessionId = input.session_id;
  const now = Date.now();
  const notices = [];
  const all = runs(sessionId, now);
  for (const name of recordNames(sessionId, NOTE)) {
    let note;
    try {
      note = readRecord(sessionId, name);
    } catch (error) {
      // Cut short by a hook that was killed while writing it: the next shell command notes afresh.
      writeRecord(sessionId, name, null);
      notices.push({ name: 'first-pass shell edits', own: true, json: { systemMessage: `first-pass: a saved git status could not be read (${error.message}), so files a shell command changed in one repo this turn are not seen by the done check or end-of-turn hooks.` } });
      continue;
    }
    // A worktree or temp clone removed since (ship-check, review) has nothing left to find.
    if (!fs.existsSync(note.root)) {
      writeRecord(sessionId, name, null);
      continue;
    }
    const since = all.filter((run) => run.to > note.at).reverse();
    if (!since.length) continue;
    const current = changedFiles(note.root, deadline);
    if (current.error) {
      notices.push(unreadable(note.root, current.error));
      continue;
    }
    const changed = new Set(Object.keys(current.files).filter((rel) => note.files[rel] !== current.files[rel]));
    // A file that left the list unchanged was committed, not edited.
    for (const rel of Object.keys(note.files)) if (!(rel in current.files) && signature(path.join(note.root, rel)) !== note.files[rel]) changed.add(rel);
    for (const rel of [...changed].sort()) {
      const file = path.join(note.root, rel);
      const time = writtenAt(file, note.root);
      // On Windows a copy over a file keeps the source's times, so a noted file that changed
      // yet looks older than the note was written that way, by the latest run.
      const keptTimes = time !== null && time < note.at && rel in note.files;
      const run = keptTimes ? since[0] : time !== null && since.find((r) => r.from <= time && time <= r.to);
      if (!run) continue;
      append({ prompt: run.prompt, tool: 'shell', file, rel: relative(ws?.root ?? path.dirname(note.root), file), repo: ws ? (repoOf(ws, file)?.name ?? null) : null, root: note.root });
    }
    writeRecord(sessionId, name, { root: note.root, at: now, files: current.files });
  }
  return notices;
}
