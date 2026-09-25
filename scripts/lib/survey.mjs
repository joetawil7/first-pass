// What setup needs to know about a workspace and each repo in it, gathered in one pass
// so the setup skill starts from facts instead of guesses. Read only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ciCommands, ciFiles } from './ci.mjs';
import { checkCursorRules, imports } from './cursor-rules.mjs';
import { entryFiles } from './fingerprint.mjs';
import { loadProblems, sameInstructionFile } from './instructions.mjs';
import { key, posix, relative } from './paths.mjs';
import { findRepos } from './repos.mjs';

const UI_DEPS = ['react', 'react-dom', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'solid-js', 'astro', 'react-native', 'expo', '@remix-run/react', 'preact', 'lit'];
const MONITORING_DEPS = [/^@sentry\//, /^dd-trace$/, /^@datadog\//, /^@bugsnag\//, /^@opentelemetry\//, /^newrelic$/, /^rollbar$/, /^@honeybadger-io\//, /^@highlight-run\//, /^sentry-sdk$/];
const TEST_CONFIG = /(^|\/)(jest|vitest|playwright|cypress|karma|ava|mocha)\.config\.[cm]?[jt]s$|(^|\/)(pytest\.ini|conftest\.py|phpunit\.xml|\.mocharc\.[a-z]+)$/;
const TEST_DIR = /(^|\/)(test|tests|__tests__|spec|e2e|flows|integration|cypress|playwright)\//;
const COMPOSE = /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/;
const I18N_DIR = /(^|\/)(locales?|i18n|lang|translations|messages)\//;
const EMAIL_DIR = /(^|\/)(emails?|mail|email-templates|templates\/emails?)\//;
const DOCS_DIR = /(^|\/)(docs?|documentation|help|help-center)\//;
const LEGAL_FILE = /(^|\/)[^/]*(privacy|terms|legal|pricing|cookies?|dpa|subprocessors)[^/]*\.(md|mdx|tsx|jsx|ts|js|html|vue|svelte|astro|json)$/i;
const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|Podfile|pubspec\.yaml|app\.json)$/;

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { unreadable: error.message };
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function unique(list) {
  return [...new Set(list)];
}

// The top folders matching a pattern, not every file in them.
function folders(files, pattern, max = 12) {
  const out = new Set();
  for (const file of files) {
    const match = pattern.exec(file);
    if (match) out.add(file.slice(0, match.index + match[0].length).replace(/\/$/, ''));
    if (out.size >= max) break;
  }
  return [...out];
}

function packageFacts(repo, files, problems) {
  const packages = files.filter((f) => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 4);
  const deps = new Set();
  const scripts = {};
  for (const file of packages) {
    const pkg = readJson(path.join(repo, file));
    if (!pkg) continue;
    if (pkg.unreadable) {
      problems.push(`${file} is not valid JSON: ${pkg.unreadable}`);
      continue;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) for (const dep of Object.keys(pkg[field] ?? {})) deps.add(dep);
    if (pkg.scripts) scripts[file] = pkg.scripts;
  }
  const lock = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'bun.lock'].find((f) => files.includes(f));
  const packageManager = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'bun.lockb': 'bun', 'bun.lock': 'bun' }[lock] ?? null;
  return { deps, scripts, packageManager };
}

// A guess for setup to confirm with the owner. React alone does not count: backends use it
// to render emails.
const UI_FRAMEWORKS = UI_DEPS.filter((dep) => dep !== 'react' && dep !== 'react-dom').concat(['react-scripts', '@vitejs/plugin-react']);

function uiFacts(deps, files) {
  const why = UI_FRAMEWORKS.filter((dep) => deps.has(dep)).map((dep) => `depends on ${dep}`);
  const count = (re) => files.filter((f) => re.test(f)).length;
  const components = count(/\.(tsx|jsx|vue|svelte|astro)$/);
  const styles = count(/\.(css|scss|sass|less)$/);
  const likely = why.length > 0 || count(/\.(vue|svelte|astro)$/) > 0;
  if (components) why.push(`${components} component files`);
  if (styles) why.push(`${styles} stylesheets`);
  return { likely, why };
}

// A repo's own Claude Code hooks, which never fire when a session starts above the repo.
// `contentKey` is equal for the same hook copied into several repos, so setup can offer it once.
function repoHooks(repo, workspaceRoot, problems) {
  const out = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(repo, '.claude', name);
    const settings = readJson(file);
    if (settings?.unreadable) problems.push(`.claude/${name} is not valid JSON: ${settings.unreadable}`);
    if (!settings?.hooks) continue;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks ?? []) {
          const referenced = entryFiles(handler, repo, workspaceRoot).map((f) => ({
            path: relative(workspaceRoot, f),
            sha256: fs.existsSync(f) ? sha256(fs.readFileSync(f)) : null,
          }));
          out.push({
            settingsFile: `.claude/${name}`,
            event,
            matcher: group.matcher ?? '',
            handler,
            referenced,
            contentKey: sha256(JSON.stringify([event, group.matcher ?? '', handler, referenced.map((r) => r.sha256)])),
          });
        }
      }
    }
  }
  return out;
}

function instructionFacts(repo, files) {
  const out = { files: {}, cursorRules: [], firstPass: { rules: null, profile: null, words: null, project: false } };
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', 'CLAUDE.local.md']) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    out.files[name] = { lines: text.split('\n').length, imports: imports(text) };
    out.firstPass.rules ??= /first-pass:rules:start v(\S+)/.exec(text)?.[1] ?? null;
    out.firstPass.profile ??= /first-pass:profile:start v(\S+)/.exec(text)?.[1] ?? null;
    out.firstPass.words ??= /first-pass:words:start (v\S+ (?:default|through \S+))/.exec(text)?.[1] ?? null;
    out.firstPass.project ||= text.includes('first-pass:project:start');
  }
  for (const file of files.filter((f) => /^\.cursor\/rules\/.+\.mdc$/.test(f))) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    out.cursorRules.push({ file, alwaysApply: /^alwaysApply:\s*true\s*$/m.test(text.split(/\n---/)[0] ?? '') });
  }
  return out;
}

export function surveyRepo(repo, workspaceRoot) {
  const listed = git(repo, ['ls-files']);
  const files = listed ? listed.split('\n').map(posix) : [];
  const problems = [];
  const { deps, scripts, packageManager } = packageFacts(repo, files, problems);
  const ci = ciFiles(repo);
  const rel = relative(workspaceRoot, repo);
  return {
    // A repo two levels down is named by its path, so two `api` folders stay apart.
    name: rel.startsWith('..') ? path.basename(repo) : rel,
    path: rel,
    remote: git(repo, ['remote', 'get-url', 'origin']),
    branch: git(repo, ['branch', '--show-current']),
    trackedFiles: files.length,
    manifests: files.filter((f) => MANIFESTS.test(f) && f.split('/').length <= 4).slice(0, 30),
    packageManager,
    frameworks: UI_DEPS.concat(['@nestjs/core', 'express', 'fastify', 'hono', 'koa', '@payloadcms/next', 'prisma', '@mikro-orm/core', 'typeorm', 'drizzle-orm']).filter((d) => deps.has(d)),
    ui: uiFacts(deps, files),
    scripts,
    ci: { files: ci, commands: ci.flatMap((file) => ciCommands(fs.readFileSync(path.join(repo, file), 'utf8')).map((c) => ({ file, ...c }))) },
    tests: {
      configs: files.filter((f) => TEST_CONFIG.test(f)).slice(0, 20),
      folders: folders(files, TEST_DIR),
      compose: files.filter((f) => COMPOSE.test(f)).slice(0, 10),
    },
    monitoring: [...deps].filter((dep) => MONITORING_DEPS.some((re) => re.test(dep))),
    words: {
      i18n: folders(files, I18N_DIR),
      emails: folders(files, EMAIL_DIR),
      docs: folders(files, DOCS_DIR),
      legalOrPricing: files.filter((f) => LEGAL_FILE.test(f) && !/(^|\/)(node_modules|test|tests|__tests__)\//.test(f)).slice(0, 20),
    },
    instructions: instructionFacts(repo, files),
    cursorRuleProblems: checkCursorRules(repo),
    loadProblems: loadProblems(repo),
    claudeMdIsAgentsMd: sameInstructionFile(repo),
    hooks: repoHooks(repo, workspaceRoot, problems),
    claude: {
      agents: files.filter((f) => /^\.claude\/agents\/.+\.md$/.test(f)).map((f) => path.basename(f, '.md')),
      skills: unique(files.filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f)).map((f) => f.split('/')[2])),
    },
    invariants: fs.existsSync(path.join(repo, 'INVARIANTS.md')),
    problems,
  };
}

// Extra folders a Cursor or VS Code workspace file adds, such as a repo kept beside the main folder.
function codeWorkspaceFolders(root) {
  const out = [];
  for (const name of fs.readdirSync(root).filter((n) => n.endsWith('.code-workspace'))) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    let json;
    try {
      // Workspace files allow comments and trailing commas.
      json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    } catch (error) {
      out.push({ file: name, problem: `not readable as JSON: ${error.message}` });
      continue;
    }
    for (const folder of json.folders ?? []) {
      if (typeof folder.path === 'string') out.push({ file: name, path: path.resolve(root, folder.path) });
      else out.push({ file: name, problem: `a folder without a "path" (${JSON.stringify(folder).slice(0, 80)}) was skipped` });
    }
  }
  return out;
}

export function surveyWorkspace(root) {
  root = path.resolve(root);
  const children = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const repoDirs = findRepos(root);
  const workspaceFolders = codeWorkspaceFolders(root);
  // The main folder may list itself (".") and may be a git repo of its own: it is not one of its repos.
  const extra = workspaceFolders.filter(
    (f) => f.path && key(f.path) !== key(root) && fs.existsSync(path.join(f.path, '.git')) && !repoDirs.some((d) => key(d) === key(f.path)),
  );
  const rootSettings = ['settings.json', 'settings.local.json'].map((n) => ({ file: `.claude/${n}`, json: readJson(path.join(root, '.claude', n)) })).filter((s) => s.json);
  return {
    root: posix(root),
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    codeWorkspaceFolders: workspaceFolders.map((f) => (f.problem ? f : { file: f.file, path: relative(root, f.path) })),
    notRepos: children.filter((e) => !repoDirs.some((d) => relative(root, d).split('/')[0] === e.name)).map((e) => e.name),
    rootInstructions: { ...instructionFacts(root, []), cursorRuleProblems: checkCursorRules(root) },
    rootClaude: {
      settings: rootSettings.map((s) => ({ file: s.file, hookEvents: Object.keys(s.json.hooks ?? {}) })),
      skills: fs.existsSync(path.join(root, '.claude', 'skills')) ? fs.readdirSync(path.join(root, '.claude', 'skills')) : [],
      agents: fs.existsSync(path.join(root, '.claude', 'agents')) ? fs.readdirSync(path.join(root, '.claude', 'agents')) : [],
    },
    repos: [...repoDirs, ...extra.map((f) => f.path)].map((dir) => surveyRepo(dir, root)),
  };
}
