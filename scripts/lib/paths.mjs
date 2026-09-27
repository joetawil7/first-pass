// Path helpers shared by the hooks and the setup CLI. Windows paths compare
// case-insensitively and may arrive with either slash, so every comparison goes
// through pathKey().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function pathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInside(file, dir) {
  const f = pathKey(file);
  const d = pathKey(dir);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

// The nearest folder at or above `start` holding a `.git` entry (a folder, or a file for
// worktrees and submodules), never climbing above `stopAt` when it is given.
export function gitRoot(start, stopAt) {
  let dir = isDirectory(start) ? path.resolve(start) : path.dirname(path.resolve(start));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (stopAt && pathKey(dir) === pathKey(stopAt)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Forward slashes, the form Claude Code gives hooks in CLAUDE_PROJECT_DIR on Windows and
// the form Git Bash expects.
export function posix(p) {
  return p.replace(/\\/g, '/');
}

export function relative(from, to) {
  return posix(path.relative(from, to)) || '.';
}

// A path as a shell command wrote it. Claude Code's Bash tool on Windows is Git Bash, which
// writes C:\x as /c/x and mounts the temp folder at /tmp (PowerShell reads /c/x as \c\x on
// the current drive); both shells read ~ as the home folder.
export function resolveShellPath(cwd, p, tool) {
  if (p === '~' || /^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  const gitBash = process.platform === 'win32' && tool === 'Bash';
  if (gitBash && /^\/tmp(\/|$)/.test(p)) return path.join(os.tmpdir(), p.slice(5));
  const drive = gitBash && /^\/([a-zA-Z])(\/|$)/.exec(p);
  return drive ? path.resolve(`${drive[1].toUpperCase()}:/`, p.slice(3)) : path.resolve(cwd, p);
}
