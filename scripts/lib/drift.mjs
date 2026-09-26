// The start-of-session check: what in the workspace no longer matches what setup wrote.
// Each line is a fact the session should know before it relies on the rules or a repo's
// section; nothing here changes a file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookProblems } from './bridge.mjs';
import { ciHash } from './ci.mjs';
import { checkCursorRules } from './cursor-rules.mjs';
import { whyPaused } from './fingerprint.mjs';
import { loadProblems, repoHooksHash } from './instructions.mjs';
import { gitRoot, pathKey, relative } from './paths.mjs';
import { findRepos } from './repos.mjs';
import { hasTypedPrompt, projectsDir, sessionFiles } from './words.mjs';
import { repoNamed } from './workspace.mjs';

const RULES_MARKER = /first-pass:rules:start v(\d+(?:\.\d+)*)/;
const PROFILE_MARKER = /first-pass:profile:start v(\d+(?:\.\d+)*)/;
const WORDS_MARKER = /first-pass:words:start v[\d.]+ (default|through (\S+))/;
export const WORDS_DUE_AFTER = 20;

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function rulesVersion(dir) {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const match = RULES_MARKER.exec(fs.readFileSync(file, 'utf8'));
    if (match) return { file: name, version: match[1] };
  }
  return null;
}

function staleRules(where, found, pluginVersion) {
  if (found && compareVersions(found.version, pluginVersion) < 0) {
    return `first-pass: the rules block in ${where}/${found.file} is v${found.version} and the plugin is v${pluginVersion}; re-running setup-first-pass updates it.`;
  }
  return null;
}

// The files a personal block can live in: the folder's own instruction files, then the
// user's global CLAUDE.md (where one-repo mode puts the profile and the habit words).
function instructionFiles(dirs, env) {
  return [...dirs.flatMap((dir) => ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(dir, name))), path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'CLAUDE.md')];
}

// The profile can sit apart from the rules, so a repo whose rules are already current says
// nothing about it. Every file holding one is checked: a user who set up one repo and later
// a main folder has two, and both load. A file whose rules block is stale too is left to
// the rules line, and a hard-linked pair (the same text twice) is reported once.
function staleProfiles(dirs, pluginVersion, env = process.env) {
  const lines = [];
  const seen = new Set();
  const files = instructionFiles(dirs, env);
  const globalFile = files[files.length - 1];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const profile = PROFILE_MARKER.exec(text);
    if (!profile || seen.has(text) || compareVersions(profile[1], pluginVersion) >= 0) continue;
    seen.add(text);
    const rules = RULES_MARKER.exec(text);
    if (rules && compareVersions(rules[1], pluginVersion) < 0) continue;
    // Setup in a main folder writes the profile at the root and never touches the global file.
    const fix = file === globalFile
      ? 're-running setup-first-pass in one-repo mode updates it, or remove it if the profile in a main folder covers this user (both load in every session)'
      : 're-running setup-first-pass updates it';
    lines.push(`first-pass: the profile block in ${file} is v${profile[1]} and the plugin is v${pluginVersion}; ${fix}.`);
  }
  return lines;
}

// The habit words are read from the user's sessions and go stale as they keep working: once
// enough sessions the user typed in have changed since the newest prompt read, the session is
// told to offer a refresh. Sessions a script started do not count, and a default block (the
// user chose not to have their sessions read) is left alone.
export function wordsDue(dirs, env = process.env) {
  let profileIn = null;
  for (const file of instructionFiles(dirs, env)) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const words = WORDS_MARKER.exec(text);
    if (words) {
      if (words[1] === 'default') return null;
      const since = Date.parse(words[2]);
      if (Number.isNaN(since)) return `first-pass: the habit words block in ${file} has no readable "through" date; the habit-words skill rewrites it.`;
      let typed = 0;
      for (const session of sessionFiles(projectsDir(env))) {
        if (session.mtimeMs <= since) break;
        if (hasTypedPrompt(session.file) && ++typed >= WORDS_DUE_AFTER) {
          return `first-pass: the habit words were read from sessions up to ${words[2].slice(0, 10)}, and at least ${WORDS_DUE_AFTER} sessions the user typed in have changed since; offer the user a refresh with the habit-words skill (a "not now" moves the block's "through" to now).`;
        }
      }
      return null;
    }
    if (!profileIn && text.includes('first-pass:profile:start')) profileIn = file;
  }
  return profileIn ? `first-pass: ${profileIn} has the profile block but no habit words block; the habit-words skill can learn the user's words from their sessions (setup-first-pass offers it).` : null;
}

export function drift(ws, input, pluginVersion) {
  const lines = [];
  const add = (line) => line && lines.push(line);
  // Once per real start, not again after a compaction or a resume of the same session.
  const fresh = !input.source || input.source === 'startup' || input.source === 'clear';
  if (input.source === 'compact') {
    add("first-pass: the context was just compacted. The working rules ask for the task's rules and open points to be re-read before continuing.");
  }

  if (!ws) {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const repo = gitRoot(cwd);
    if (repo) {
      add(staleRules(path.basename(repo), rulesVersion(repo), pluginVersion));
      for (const problem of checkCursorRules(repo)) add(`first-pass: ${path.basename(repo)}: ${problem}.`);
    } else {
      const repos = findRepos(cwd);
      if (repos.length >= 2) add(`first-pass: this folder holds ${repos.length} git repos and has no first-pass setup; setup-first-pass sets it up for all of them.`);
    }
    for (const line of staleProfiles(repo ? [repo] : [], pluginVersion)) add(line);
    if (fresh) add(wordsDue(repo ? [repo] : []));
    return lines;
  }

  const root = rulesVersion(ws.root);
  add(root ? staleRules('the workspace', root, pluginVersion) : 'first-pass: the workspace has no first-pass rules block (setup-first-pass writes it).');
  for (const line of staleProfiles([ws.root], pluginVersion)) add(line);
  if (fresh) add(wordsDue([ws.root]));
  for (const problem of checkCursorRules(ws.root)) add(`first-pass: the workspace: ${problem}.`);

  const known = new Set(ws.repos.map((repo) => pathKey(repo.abs)));
  const ignored = new Set((ws.config.ignore ?? []).map((name) => pathKey(path.resolve(ws.root, name))));
  for (const dir of findRepos(ws.root)) {
    if (!known.has(pathKey(dir)) && !ignored.has(pathKey(dir))) {
      add(`first-pass: ${relative(ws.root, dir)} is a git repo in the workspace that workspace.json does not list; it has no first-pass section yet.`);
    }
  }

  for (const repo of ws.repos) {
    if (!fs.existsSync(path.join(repo.abs, '.git'))) {
      add(`first-pass: workspace.json lists ${repo.name} at ${repo.path}, and there is no git repo there.`);
      continue;
    }
    if (repo.ci?.hash && ciHash(repo.abs) !== repo.ci.hash) {
      add(`first-pass: ${repo.name}'s CI config changed since its first-pass section was written; the commands listed there may be out of date.`);
    }
    if (repo.hooksHash && repoHooksHash(repo.abs) !== repo.hooksHash) {
      add(`first-pass: ${repo.name}'s own Claude Code hooks changed since setup; a new or changed hook does not run from the main folder until setup-first-pass reviews it.`);
    }
    add(staleRules(repo.name, rulesVersion(repo.abs), pluginVersion));
    for (const problem of [...checkCursorRules(repo.abs), ...loadProblems(repo.abs)]) add(`first-pass: ${repo.name}: ${problem}.`);
  }

  for (const hook of ws.hooks) {
    for (const problem of hookProblems(hook)) add(`first-pass: the ${hook.id} hook in workspace.json never runs as written: ${problem}.`);
    const homes = hook.scope === 'session' ? [hook.from] : hook.repos;
    for (const name of homes) {
      const repo = repoNamed(ws, name);
      const why = fs.existsSync(repo.abs) && whyPaused(hook, repo.abs, ws.root);
      if (why) add(`first-pass: the ${hook.id} hook for ${name} is paused because ${why}; setup-first-pass can approve it again.`);
    }
  }
  return lines;
}
