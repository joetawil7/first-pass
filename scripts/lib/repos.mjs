// Which git repos a main folder holds, found the same way by the survey and by the
// start-of-session check: up to two levels down (a `clients/api` layout), through junctions
// and symlinks, never inside a repo already found, skipping dot-folders and node_modules.
import fs from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 2;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory(); // follows junctions and symlinks
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
}

export function findRepos(root, depth = 1) {
  const repos = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const dir = path.join(root, entry.name);
    if (!isDir(dir)) continue;
    if (fs.existsSync(path.join(dir, '.git'))) repos.push(dir);
    else if (depth < MAX_DEPTH) repos.push(...findRepos(dir, depth + 1));
  }
  return repos;
}
