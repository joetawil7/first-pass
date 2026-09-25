// Reads `.first-pass/workspace.json`: the one list of repos and approved hooks that every
// hook reads, so no repo name is ever hard-coded.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, key } from './paths.mjs';

export const CONFIG_PATH = path.join('.first-pass', 'workspace.json');

export function findWorkspace(start) {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG_PATH);
    if (fs.existsSync(file)) return loadWorkspace(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadWorkspace(root) {
  const file = path.join(root, CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.firstPass !== 1 || !Array.isArray(config.repos)) {
    throw new Error(`${file} is not a first-pass workspace file (needs "firstPass": 1 and a "repos" list)`);
  }
  const repos = config.repos.map((repo) => {
    if (!repo.name || !repo.path) throw new Error(`${file}: every repo needs a name and a path`);
    return { ...repo, abs: path.resolve(root, repo.path) };
  });
  const names = new Set(repos.map((repo) => repo.name));
  const hooks = (config.hooks ?? []).map((hook) => {
    if (!hook.id || !hook.events || !hook.command) {
      throw new Error(`${file}: every hook needs an id, events and a command`);
    }
    const scope = hook.scope ?? 'files';
    if (scope !== 'files' && scope !== 'session') throw new Error(`${file}: hook ${hook.id} has scope "${scope}"`);
    const repoNames = hook.repos ?? (hook.from ? [hook.from] : []);
    for (const name of [hook.from, ...repoNames, ...(hook.sameAs ?? [])].filter(Boolean)) {
      if (!names.has(name)) throw new Error(`${file}: hook ${hook.id} names repo "${name}", which is not in "repos"`);
    }
    if (scope === 'session' && !hook.from) throw new Error(`${file}: session hook ${hook.id} needs "from"`);
    if (scope === 'files' && !repoNames.length) throw new Error(`${file}: files hook ${hook.id} needs "repos" or "from"`);
    return { ...hook, scope, repos: repoNames };
  });
  return { root: path.resolve(root), file, config, repos, hooks };
}

// The configured repo that contains `file`. Nested paths (a worktree inside a repo folder)
// resolve to the deepest configured repo.
export function repoOf(ws, file) {
  let best = null;
  for (const repo of ws.repos) {
    if (isInside(file, repo.abs) && (!best || key(repo.abs).length > key(best.abs).length)) best = repo;
  }
  return best;
}

export function repoNamed(ws, name) {
  return ws.repos.find((repo) => repo.name === name) ?? null;
}
