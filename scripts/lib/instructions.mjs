// Instruction files Claude Code will not load, found by reading them. Tested on Claude Code
// 2.1.280 (2026-09-25): once the folder a session starts in has a CLAUDE.md, a repo's
// AGENTS.md loads only if that repo's CLAUDE.md imports it (`@AGENTS.md`); a repo with an
// AGENTS.md and no CLAUDE.md loads nothing; and an `@import` of a `.mdc` file never loads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { imports } from './cursor-rules.mjs';

export function importsAgentsMd(claudeMdText) {
  return imports(claudeMdText).some((target) => target.replace(/^\.[\\/]/, '') === 'AGENTS.md');
}

// A Claude Code plugin's own repo: `claude plugin validate --strict` rejects a CLAUDE.md at
// its root, so its rules live in AGENTS.md on purpose.
export function isPluginRepo(repoDir) {
  return fs.existsSync(path.join(repoDir, '.claude-plugin', 'plugin.json'));
}

// True when CLAUDE.md and AGENTS.md are one file (a hard link, or a symlink to the other):
// writing either rewrites both, so setup must never turn one into an import of the other.
export function sameInstructionFile(repoDir) {
  const agents = path.join(repoDir, 'AGENTS.md');
  const claude = path.join(repoDir, 'CLAUDE.md');
  if (!fs.existsSync(agents) || !fs.existsSync(claude)) return false;
  const a = fs.statSync(agents, { bigint: true });
  const c = fs.statSync(claude, { bigint: true });
  return a.dev === c.dev && a.ino === c.ino;
}

// One line per problem, for a repo inside a main folder.
export function loadProblems(repoDir) {
  const agents = path.join(repoDir, 'AGENTS.md');
  const claude = path.join(repoDir, 'CLAUDE.md');
  if (!fs.existsSync(agents) || isPluginRepo(repoDir) || sameInstructionFile(repoDir)) return [];
  if (!fs.existsSync(claude)) return ['has an AGENTS.md and no CLAUDE.md, so Claude Code does not load its AGENTS.md from the main folder (a CLAUDE.md with `@AGENTS.md` fixes it)'];
  if (!importsAgentsMd(fs.readFileSync(claude, 'utf8'))) return ['CLAUDE.md does not import AGENTS.md (`@AGENTS.md`), so Claude Code never loads that AGENTS.md'];
  return [];
}

// A hash of a repo's own Claude Code hooks, to notice hooks added or changed after setup.
export function repoHooksHash(repoDir) {
  const hash = crypto.createHash('sha256');
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(repoDir, '.claude', name);
    if (!fs.existsSync(file)) continue;
    let hooks;
    try {
      hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks ?? null;
    } catch (error) {
      hooks = `unreadable: ${error.message}`;
    }
    hash.update(`${name}\0${JSON.stringify(hooks)}\0`);
  }
  return hash.digest('hex');
}
