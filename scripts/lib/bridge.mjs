// Runs approved hooks on behalf of the repos in a workspace. A repo's own
// .claude/settings*.json hooks never fire when the session starts in the folder above
// it, so first-pass runs them itself:
//   scope "files":   for tool calls on a file in one of the hook's repos, and on Stop for
//                    each of its repos this session edited, from that repo's folder;
//   scope "session": for every matching event, from its home repo (`from`).
// When the session started inside a repo, Claude Code already runs that repo's hooks, so
// they are not run a second time here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { whyPaused } from './fingerprint.mjs';
import { gitRoot, key, posix } from './paths.mjs';
import { repoNamed, repoOf } from './workspace.mjs';

// Must equal the timeouts in hooks/hooks.json (a test checks). A bridged hook gets a little
// less, so first-pass can still answer before Claude Code gives up on it.
export const EVENT_LIMITS = { SessionStart: 30, UserPromptSubmit: 30, PreToolUse: 60, PostToolUse: 60, Stop: 120 };
export const SUPPORTED_EVENTS = Object.keys(EVENT_LIMITS);
export const SESSION_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MARGIN_SECONDS = 5;
// After a hook exits, how long to wait for output still in its pipes before answering. A
// background process it started can hold those pipes open for as long as it lives.
const DRAIN_MS = 300;

export function effectiveTimeout(hook, event) {
  return Math.min(hook.timeout ?? 60, (EVENT_LIMITS[event] ?? 60) - MARGIN_SECONDS);
}

// Why an entry in workspace.json would never run: an event first-pass does not register,
// or a files hook on an event that has no file and no repo.
export function hookProblems(hook) {
  const problems = [];
  for (const event of Object.keys(hook.events)) {
    if (!SUPPORTED_EVENTS.includes(event)) problems.push(`${event} is not an event first-pass runs hooks on (${SUPPORTED_EVENTS.join(', ')})`);
    else if ((hook.scope ?? 'files') === 'files' && SESSION_EVENTS.has(event)) problems.push(`${event} has no file, so a files-scope hook never runs on it; use scope "session"`);
  }
  if (hook.async || hook.asyncRewake) problems.push('it is async, and first-pass waits for every hook it runs (drop "async" to run it in line)');
  return problems;
}

// Claude Code's matcher rules: empty or "*" matches all; letters, digits, _, -, spaces, ","
// and "|" only is an exact list; anything else is an unanchored regular expression.
export function matches(matcher, value) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .includes(value);
  }
  return new RegExp(matcher).test(value ?? '');
}

export function toolTarget(input) {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return file ? path.resolve(input.cwd ?? process.cwd(), file) : null;
}

// The folder a shell command works in when it says so: `git -C <dir> ...`, or a leading
// `cd <dir> &&` / `Set-Location <dir>;`. From a main folder that is how a command reaches a
// repo, so a repo's Bash guard must see it.
export function commandTarget(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const quoted = '"([^"]+)"|\'([^\']+)\'|([^\\s;&|]+)';
  const match =
    new RegExp(`\\bgit\\s+-C\\s+(?:${quoted})`).exec(command) ??
    new RegExp(`^\\s*(?:cd|Set-Location|pushd)\\s+(?:${quoted})\\s*(?:&&|;|\\|\\||$)`, 'i').exec(command);
  if (!match) return null;
  return path.resolve(input.cwd ?? process.cwd(), match[1] ?? match[2] ?? match[3]);
}

// The repos whose own hooks Claude Code runs natively in this session: the one it started
// in, when it started inside a listed repo. A session hook copied into several repos names
// the copies in `sameAs`.
function nativelyCovered(hook, repo, startRepo) {
  if (!startRepo) return false;
  if (hook.scope === 'session') return [hook.from, ...(hook.sameAs ?? [])].includes(startRepo.name);
  return repo.name === startRepo.name;
}

// `edited(hook)` lists { repo, root } for the hook's repos edited since its last Stop run.
export function selectRuns(event, input, ws, edited, startRepo = null) {
  const runs = [];
  for (const hook of ws.hooks) {
    if (!SUPPORTED_EVENTS.includes(event) || !Object.hasOwn(hook.events, event)) continue;
    const matcher = hook.events[event];
    if (TOOL_EVENTS.has(event) && !matches(matcher, input.tool_name)) continue;
    if (event === 'SessionStart' && !matches(matcher, input.source)) continue;

    if (hook.scope === 'session') {
      const repo = repoNamed(ws, hook.from);
      if (!nativelyCovered(hook, repo, startRepo)) runs.push({ hook, repo, cwd: repo.abs });
      continue;
    }
    if (TOOL_EVENTS.has(event)) {
      // A shell command has no file; it belongs to the repo it names or runs in, if any.
      const where = toolTarget(input) ?? commandTarget(input) ?? (input.cwd ? path.resolve(input.cwd) : null);
      const repo = where && repoOf(ws, where);
      if (repo && hook.repos.includes(repo.name) && !nativelyCovered(hook, repo, startRepo)) {
        runs.push({ hook, repo, cwd: gitRoot(where, repo.abs) ?? repo.abs });
      }
    } else if (event === 'Stop') {
      const seen = new Set();
      for (const { repo: name, root } of edited(hook)) {
        const repo = repoNamed(ws, name);
        if (!repo || !hook.repos.includes(name) || nativelyCovered(hook, repo, startRepo) || seen.has(key(root))) continue;
        seen.add(key(root));
        runs.push({ hook, repo, cwd: root });
      }
    }
  }
  return runs;
}

let shell;
// How Claude Code runs a shell-form hook: Git Bash on Windows (found through git itself,
// because the first `bash` on a Windows PATH can be WSL's), PowerShell when there is none.
function shellFor(command) {
  if (process.platform !== 'win32') return ['/bin/sh', ['-c', command]];
  if (shell === undefined) {
    shell = process.env.CLAUDE_CODE_GIT_BASH_PATH || null;
    if (!shell) {
      const where = spawnSync('where', ['git'], { encoding: 'utf8' });
      for (const git of (where.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
        const candidate = path.resolve(path.dirname(git), git.toLowerCase().includes('mingw64') ? '../../bin/bash.exe' : '../bin/bash.exe');
        if (fs.existsSync(candidate)) {
          shell = candidate;
          break;
        }
      }
    }
  }
  return shell ? [shell, ['-c', command]] : [powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]];
}

let powershell;
// Claude Code's `"shell": "powershell"`: PowerShell 7 (pwsh.exe) when installed, else
// Windows PowerShell 5.1.
function powershellExe() {
  powershell ??= spawnSync('where', ['pwsh'], { encoding: 'utf8' }).status === 0 ? 'pwsh.exe' : 'powershell.exe';
  return powershell;
}

function kill(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}

export function runHook({ hook, repo, cwd }, input, ws, event = input.hook_event_name) {
  const name = `${hook.id} (${repo.name})`;
  const label = hook.scope === 'files' ? `${hook.id} in ${repo.name}` : null;
  const paused = whyPaused(hook, repo.abs, ws.root);
  if (paused) return Promise.resolve({ name, label, paused });

  const vars = { CLAUDE_PROJECT_DIR: posix(repo.abs), FIRST_PASS_WORKSPACE: posix(ws.root) };
  const substitute = (text) => String(text).replace(/\$\{?(CLAUDE_PROJECT_DIR|FIRST_PASS_WORKSPACE)\}?/g, (_, v) => vars[v]);
  const options = { cwd, env: { ...process.env, ...vars }, windowsHide: true };

  let child;
  try {
    if (hook.args) child = spawn(substitute(hook.command), hook.args.map(substitute), options);
    else if (hook.shell === 'powershell') {
      child = spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', substitute(hook.command)], options);
    } else child = spawn(...shellFor(hook.command), options);
  } catch (error) {
    // Node refuses some commands before starting them (a .cmd in exec form on Windows).
    return Promise.resolve({ name, label, status: 127, stdout: '', stderr: error.message });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Let go of pipes a leftover background process may still hold, so first-pass can exit.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ name, label, stdout, stderr, ...result });
    };
    timer = setTimeout(() => {
      kill(child);
      finish({ status: null, timedOut: true });
    }, effectiveTimeout(hook, event) * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => finish({ status: 127, stderr: stderr + error.message }));
    child.on('close', (status) => finish({ status: status ?? 1 }));
    child.on('exit', (status) => setTimeout(() => finish({ status: status ?? 1 }), DRAIN_MS));
    child.stdin.on('error', (error) => {
      // A hook that exits without reading its input closes the pipe first: that is fine.
      if (error.code !== 'EPIPE' && error.code !== 'EOF') stderr += `first-pass could not send the hook its input: ${error.message}\n`;
    });
    child.stdin.end(JSON.stringify({ ...input, cwd }));
  });
}
