// What an approval covers: the hook's definition, and every file in the folder of each
// script its command runs (a launcher and the binary beside it, a script and the helpers
// it requires). A repo hook that changes after approval (a pull brings a new version) is
// paused until it is approved again, because first-pass runs it on the owner's behalf.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { relative } from './paths.mjs';

const PLACEHOLDER = /\$\{?(CLAUDE_PROJECT_DIR|FIRST_PASS_WORKSPACE)\}?/g;
const SCRIPT = /\.(c?js|mjs|ts|sh|bash|ps1|py|rb|cmd|bat|exe)$/i;
const FOLDER_LIMIT = { files: 200, bytes: 64 * 1024 * 1024 };

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Shell words, with quotes removed: enough to find the paths in a hook command.
function words(text) {
  return [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// The scripts a hook's command runs: every word that names a placeholder path, and every
// word that is an existing file relative to the repo.
export function entryFiles(hook, projectDir, workspaceRoot) {
  const base = { CLAUDE_PROJECT_DIR: projectDir, FIRST_PASS_WORKSPACE: workspaceRoot };
  const entries = new Set();
  const all = hook.args ? [hook.command, ...hook.args] : words(hook.command);
  for (const word of all) {
    const placeholders = [...String(word).matchAll(PLACEHOLDER)];
    if (placeholders.length) {
      entries.add(path.resolve(String(word).replace(PLACEHOLDER, (_, v) => base[v])));
      continue;
    }
    if (!/[\\/]/.test(word) && !SCRIPT.test(word)) continue;
    const candidate = path.resolve(projectDir, word);
    if (isFile(candidate)) entries.add(candidate);
  }
  return [...entries];
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function walk(dir, out, budget) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (!walk(full, out, budget)) return false;
    } else if (entry.isFile()) {
      budget.files -= 1;
      budget.bytes -= fs.statSync(full).size;
      if (budget.files < 0 || budget.bytes < 0) return false;
      out.push(full);
    }
  }
  return true;
}

// Every pinned file with its hash (null for an entry that does not exist), keyed by its
// path relative to the workspace. `partial` is true when a folder was too big to pin whole.
export function pinned(hook, projectDir, workspaceRoot) {
  const files = {};
  let partial = false;
  for (const entry of entryFiles(hook, projectDir, workspaceRoot)) {
    if (!isFile(entry)) {
      files[relative(workspaceRoot, entry)] = null;
      continue;
    }
    const folder = [];
    if (!walk(path.dirname(entry), folder, { ...FOLDER_LIMIT })) {
      partial = true;
      folder.length = 0;
      folder.push(entry);
    }
    for (const file of folder) files[relative(workspaceRoot, file)] = sha256(fs.readFileSync(file));
  }
  return { files, partial };
}

export function specHash(hook) {
  const events = Object.fromEntries(Object.entries(hook.events).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(
    JSON.stringify({
      events,
      command: hook.command,
      args: hook.args ?? null,
      shell: hook.shell ?? null,
      scope: hook.scope ?? 'files',
    }),
  );
}

// The approval record for every repo the hook runs for.
export function approval(hook, projectDirs, workspaceRoot) {
  const files = {};
  let partial = false;
  for (const dir of projectDirs) {
    const found = pinned(hook, dir, workspaceRoot);
    Object.assign(files, found.files);
    partial ||= found.partial;
  }
  return { spec: specHash(hook), files, partial };
}

// Why the hook may not run for `projectDir`, or null when it may.
export function whyPaused(hook, projectDir, workspaceRoot) {
  const approved = hook.approved;
  if (!approved) return 'it has not been approved';
  if (approved.spec !== specHash(hook)) return 'its definition changed since it was approved';
  const current = pinned(hook, projectDir, workspaceRoot).files;
  for (const [rel, hash] of Object.entries(current)) {
    if (!(rel in approved.files)) return `${rel} was not part of the approval`;
    if (approved.files[rel] !== hash) return `${rel} changed since it was approved`;
  }
  // A pinned file that is gone is a change too, when it sat in a folder pinned for this repo.
  const folders = Object.entries(current)
    .filter(([, hash]) => hash !== null)
    .map(([rel]) => path.posix.dirname(rel));
  for (const rel of Object.keys(approved.files)) {
    if (!(rel in current) && folders.some((folder) => rel.startsWith(folder + '/'))) return `${rel} was removed since it was approved`;
  }
  return null;
}
