#!/usr/bin/env node
// The deterministic half of setup-first-pass. The skill decides what to write; this
// computes what must match the runtime exactly (approvals, hashes) and reads the facts.
//
//   node cli.mjs survey [workspace]             facts about the workspace and every repo, as JSON
//   node cli.mjs record [workspace] [--ci <repo>|--ci all]
//                                               stamps workspace.json: the plugin version, each repo's
//                                               hooks hash, a CI hash for repos that have none (or the
//                                               named ones, once their section's CI line is updated),
//                                               and an approval for every hook marked "approve": true
//   node cli.mjs cursor-rules <repo> [--check]  points .mdc imports at .md copies and writes them;
//                                               --check only lists problems and exits 1 on any
//   node cli.mjs check [workspace]              what the start-of-session check would say now
//   node cli.mjs words [--sessions <n>]         what the user typed in their last n sessions (20),
//                                               to a temp file, with counts per phrase family
//   node cli.mjs words --count <regex> ...      how many of those prompts match each regex
//   node cli.mjs words --delete <file>          deletes a file `words` wrote
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveTimeout, hookProblems } from './lib/bridge.mjs';
import { ciFiles, ciHash } from './lib/ci.mjs';
import { checkCursorRules, syncCursorRules } from './lib/cursor-rules.mjs';
import { drift } from './lib/drift.mjs';
import { approval } from './lib/fingerprint.mjs';
import { repoHooksHash } from './lib/instructions.mjs';
import { surveyWorkspace } from './lib/survey.mjs';
import { countMatching, deleteWordsFile, projectsDir, readRecent, removeStaleWordsFiles, summary, writeWordsFile } from './lib/words.mjs';
import { CONFIG_PATH, loadWorkspace } from './lib/workspace.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginVersion = () => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function head(repo) {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function record(root, ciNames) {
  const file = path.join(root, CONFIG_PATH);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ws = loadWorkspace(root); // validates before anything is written
  const byName = new Map(ws.repos.map((repo) => [repo.name, repo]));
  const lines = [];

  const problems = ws.hooks.flatMap((hook) => hookProblems(hook).map((p) => `${hook.id}: ${p}`));
  if (problems.length) throw new Error(`these hook entries could never run as written:\n${problems.join('\n')}`);
  for (const name of ciNames) if (name !== 'all' && !byName.has(name)) throw new Error(`--ci ${name}: no such repo in ${CONFIG_PATH}`);

  raw.version = pluginVersion();
  for (const repo of raw.repos) {
    const abs = byName.get(repo.name).abs;
    if (!fs.existsSync(path.join(abs, '.git'))) throw new Error(`${repo.name}: no git repo at ${abs}`);
    repo.hooksHash = repoHooksHash(abs);
    const hash = ciHash(abs);
    // A changed CI hash is kept until the repo's section says so, or the warning would vanish
    // while the commands in the section stay stale.
    if (!repo.ci?.hash || ciNames.includes('all') || ciNames.includes(repo.name)) repo.ci = { files: ciFiles(abs), hash };
    else if (repo.ci.hash !== hash) {
      lines.push(`${repo.name}: CI changed since its section was written; update its CI line, then run record --ci ${repo.name}`);
    }
  }
  for (const hook of raw.hooks ?? []) {
    const scope = hook.scope ?? 'files';
    for (const event of Object.keys(hook.events)) {
      const capped = effectiveTimeout(hook, event);
      if ((hook.timeout ?? 60) > capped) lines.push(`note: ${hook.id} gets ${capped}s on ${event} (its own timeout is ${hook.timeout ?? 60}s), so first-pass can answer before Claude Code's limit`);
    }
    if (hook.approve !== true) continue;
    const homes = scope === 'session' ? [hook.from] : (hook.repos ?? [hook.from]);
    const dirs = homes.map((name) => byName.get(name).abs);
    // The commits let the next re-approval show what changed: git -C <repo> diff <commit> -- <files>.
    hook.approved = { ...approval({ ...hook, scope }, dirs, root), commits: Object.fromEntries(homes.map((name, i) => [name, head(dirs[i])])) };
    delete hook.approve;
    const count = Object.keys(hook.approved.files).length;
    lines.push(`approved ${hook.id} for ${homes.join(', ')} (${count} file(s) pinned)`);
    if (!count) lines.push(`warning: ${hook.id} runs no script file first-pass can find, so a change to what it runs will not pause it`);
    if (hook.approved.partial) lines.push(`warning: a folder ${hook.id} runs from is too big to pin whole; only its entry script is pinned`);
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  loadWorkspace(root);
  lines.push(`recorded plugin version ${raw.version} and ${raw.repos.length} repo(s) in ${CONFIG_PATH}`);
  return lines.join('\n');
}

async function words(options) {
  if (options['--delete'].length) {
    for (const file of options['--delete']) deleteWordsFile(file);
    return `deleted ${options['--delete'].join(', ')}`;
  }
  const count = Number(options['--sessions'].at(-1) ?? 20);
  if (!Number.isInteger(count) || count < 1) throw new Error('--sessions takes a whole number above 0');
  const result = await readRecent(projectsDir(), count);
  if (options['--count'].length) {
    return options['--count']
      .map((pattern) => {
        const re = new RegExp(pattern, 'i');
        const n = countMatching(result.sessions, (p) => re.test(p.text));
        return `${String(n.prompts).padStart(4)} prompt(s), ${String(n.sessions).padStart(2)} session(s)  /${pattern}/i`;
      })
      .join('\n');
  }
  if (!result.sessions.length) return `no prompts you typed were found in ${projectsDir()}`;
  const stale = removeStaleWordsFiles();
  const file = writeWordsFile(result);
  return [
    `Wrote ${file}. It holds your prompts: delete it when done with`,
    `  node "${fileURLToPath(import.meta.url)}" words --delete "${file}"`,
    ...(stale.length ? [`Removed ${stale.length} words file(s) older than 6 hours that an unfinished run left.`] : []),
    summary(result),
  ].join('\n');
}

const args = process.argv.slice(2);
const command = args[0];
const flags = [];
const ciNames = [];
const positional = [];
const options = { '--sessions': [], '--count': [], '--delete': [] };
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--ci') ciNames.push(args[++i] ?? 'all');
  else if (Object.hasOwn(options, args[i])) {
    if (i + 1 >= args.length) throw new Error(`${args[i]} needs a value`);
    options[args[i]].push(args[++i]);
  } else if (args[i].startsWith('--')) flags.push(args[i]);
  else positional.push(args[i]);
}
const dir = path.resolve(positional[0] ?? '.');

if (command === 'survey') {
  process.stdout.write(JSON.stringify(surveyWorkspace(dir), null, 2) + '\n');
} else if (command === 'record') {
  console.log(record(dir, ciNames));
} else if (command === 'cursor-rules') {
  if (flags.includes('--check')) {
    const problems = checkCursorRules(dir);
    for (const problem of problems) console.log(problem);
    process.exitCode = problems.length ? 1 : 0;
  } else {
    const changes = syncCursorRules(dir);
    console.log(changes.length ? changes.join('\n') : 'nothing to change');
  }
} else if (command === 'check') {
  const ws = fs.existsSync(path.join(dir, CONFIG_PATH)) ? loadWorkspace(dir) : null;
  const lines = drift(ws, { cwd: dir, source: 'startup' }, pluginVersion());
  console.log(lines.length ? lines.join('\n') : 'first-pass: nothing out of date');
} else if (command === 'words') {
  console.log(await words(options));
} else {
  console.error('usage: node cli.mjs survey|check [workspace] | record [workspace] [--ci <repo>|all] | cursor-rules <repo> [--check] | words [--sessions <n>] [--count <regex>] [--delete <file>]');
  process.exitCode = 2;
}
