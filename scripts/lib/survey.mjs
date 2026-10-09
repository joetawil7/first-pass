// What setup needs to know about a workspace and each repo in it, gathered in one pass
// so the setup skill starts from facts instead of guesses. Read only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciCommands, ciFiles } from './ci.mjs';
import { checkCursorRules, imports } from './cursor-rules.mjs';
import { entryFiles } from './fingerprint.mjs';
import { loadProblems, sameInstructionFile } from './instructions.mjs';
import { isNetworkPath, pathKey, posix, relative } from './paths.mjs';
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

// What a local run could send to real people. Only example env files a repo commits are read,
// and only the variable names come out: never a value, never a real .env.
const ENV_EXAMPLE = /(^|\/)(\.?env\.(example|sample|template|dist|defaults)|example\.env|\.env\.[\w.-]+\.(example|sample|template|dist))$/;
// One optional run of spaces before the name: two in a row backtrack quadratically on a line
// that is only whitespace.
const ENV_NAME = /^\s*(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;
const CREDENTIAL = /(KEY|TOKEN|SECRET|PASS|PASSWORD|SID|WEBHOOK|HOST|DSN|SERVICE_ACCOUNT)/;
// Names a browser or app bundle ships to everyone are public by design (a publishable payments
// key, a push app id), never a sender, unless the name says it is a secret anyway. Email, SMS
// and chat vendors have no public keys, so any key of theirs sends, prefix or not. Kinds are
// matched on the name without its prefix, so NEXT_PUBLIC_FACEBOOK_APP_SECRET is publishing's.
const PUBLIC_PREFIX = /^(NEXT_PUBLIC|NUXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC|GATSBY|STORYBOOK)_/;
const SECRET_NAME = /WEBHOOK|SECRET|AUTH_TOKEN|BOT_TOKEN|REST_API_KEY|PASS|PRIVATE/;
const NO_PUBLIC_KEYS = new Set(['email', 'sms', 'chat']);
// Framework mail settings that point at a mail server (Laravel MAIL_, Django EMAIL_, Symfony
// MAILER_, Auth.js EMAIL_SERVER_), only at the start of the name: ADMIN_EMAIL_PASSWORD is a
// login, not a sender, and EMAIL_VERIFICATION_URL is a link.
const MAIL_SETTING = /^(MAIL|MAILER|EMAIL)_((SERVER|SMTP|PROVIDER|SERVICE|API|SENDER|APP)_)?(SERVER|HOST|HOST_USER|HOST_PASSWORD|USER|USERNAME|PASSWORD|PASS|KEY|API_KEY|API_TOKEN|TOKEN|SECRET|DSN|URL)$/;
// A vendor's name may follow a project prefix (APP_SENDGRID_API_KEY), except for publishing,
// whose vendor names are common words (WORKER_THREADS_KEY). X's are listed whole: X_API_KEY is
// also the usual name for an x-api-key header.
const SENDER_KINDS = [
  ['email', /(^|_)(RESEND|SENDGRID|MAILGUN|POSTMARK|MAILJET|MANDRILL|BREVO|SENDINBLUE|SPARKPOST|MAILERSEND|LOOPS|SMTP|AWS_SES|SES|GMAIL|NODEMAILER)_/],
  ['sms', /(^|_)(TWILIO|VONAGE|NEXMO|MESSAGEBIRD|BIRD|PLIVO|SINCH|TELNYX|INFOBIP|WHATSAPP)_/],
  ['push', /(^|_)((ONESIGNAL|FCM|APNS|EXPO_PUSH|NOVU|KNOCK|COURIER|PUSHER_BEAMS)(_|$)|FIREBASE_(PRIVATE_KEY|SERVER_KEY|SERVICE_ACCOUNT))/],
  ['chat', /(^|_)(SLACK|DISCORD|TELEGRAM)_/],
  ['payments', /(^|_)(STRIPE|PADDLE|LEMONSQUEEZY|LEMON_SQUEEZY|BRAINTREE|ADYEN|PAYPAL|MOLLIE|REVENUECAT)_/],
  ['publishing', /^(FACEBOOK|META|INSTAGRAM|LINKEDIN|TWITTER|TIKTOK|YOUTUBE|THREADS|PINTEREST)_|^X_(API_(BEARER_TOKEN|SECRET|SECRET_KEY|KEY_SECRET)|BEARER_TOKEN|ACCESS_TOKEN(_SECRET)?|ACCESS_SECRET|APP_(KEY|SECRET)|CLIENT_SECRET|OAUTH2_CLIENT_SECRET|REFRESH_TOKEN|CONSUMER_(KEY|SECRET))$/],
];
// Switches that keep a local run from sending: a skipped schedule, a dry run, a sending toggle.
const SWITCH = /(SKIP_CRONS?|DISABLE_CRONS?|CRONS?_(ENABLED|DISABLED)|DRY_RUN|TEST_MODE|SANDBOX(_MODE)?|DISABLE_(EMAILS?|SMS|PUSH|NOTIFICATIONS?|SENDING)|(EMAILS?|MAILER|MAIL|SMS|PUSH|NOTIFICATIONS?)_(ENABLED|DISABLED|DRIVER|TRANSPORT|PROVIDER|DRY_RUN|MAILER|BACKEND))$/;
const SENDER_PACKAGES = {
  email: ['resend', '@sendgrid/mail', 'nodemailer', 'postmark', 'mailgun.js', 'mailgun-js', '@aws-sdk/client-ses', '@aws-sdk/client-sesv2', 'node-mailjet', '@getbrevo/brevo'],
  sms: ['twilio', '@vonage/server-sdk', 'messagebird', 'plivo', 'telnyx'],
  push: ['firebase-admin', 'expo-server-sdk', 'onesignal-node', '@onesignal/node-onesignal', 'web-push', '@novu/node', '@novu/api', '@knocklabs/node'],
  chat: ['@slack/web-api', '@slack/webhook', 'discord.js', 'telegraf', 'node-telegram-bot-api'],
  payments: ['stripe', '@paddle/paddle-node-sdk', '@lemonsqueezy/lemonsqueezy.js', 'braintree', '@paypal/checkout-server-sdk', '@adyen/api-library'],
  publishing: ['twitter-api-v2', 'facebook-nodejs-business-sdk'],
};
const MAX_ENV_BYTES = 256 * 1024;

// Tools a session can look at a UI with, or that a heavy run starts.
const MACHINE_TOOLS = ['agent-device', 'maestro', 'detox', 'appium', 'adb', 'emulator', 'xcrun', 'docker', 'ffmpeg'];
const SIMCTL_TIMEOUT_MS = 15_000;

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

// What a local run of this repo could send to real people (email, SMS, push, chat, payments,
// publishing), and the switches that stop it, from the names in the example env files it
// commits and the sending packages it depends on. Setup turns this into the repo section's
// "Local runs that reach real people" line, after reading the code that uses each one.
function outwardFacts(repo, files, deps, problems) {
  // Every one is read, at any depth (names only, each capped): a sender in the eleventh file of
  // a monorepo, or in apps/api/src/config, must not be missed.
  const examples = files.filter((f) => ENV_EXAMPLE.test(f));
  const senders = new Map();
  const switches = new Map();
  for (const file of examples) {
    let text;
    try {
      const fd = fs.openSync(path.join(repo, file), 'r');
      try {
        const buffer = Buffer.alloc(MAX_ENV_BYTES);
        text = buffer.subarray(0, fs.readSync(fd, buffer, 0, MAX_ENV_BYTES, 0)).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      problems.push(`${file} could not be read: ${error.code ?? error.message}`);
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const name = ENV_NAME.exec(line)?.[1];
      if (!name) continue;
      const isPublic = PUBLIC_PREFIX.test(name) || name.includes('PUBLISHABLE');
      if (SWITCH.test(name)) {
        if (!isPublic && !switches.has(name)) switches.set(name, { name, file });
        continue;
      }
      const bare = name.replace(PUBLIC_PREFIX, '');
      const kind = MAIL_SETTING.test(bare) ? 'email' : CREDENTIAL.test(bare) && SENDER_KINDS.find(([, re]) => re.test(bare))?.[0];
      if (!kind || (isPublic && !NO_PUBLIC_KEYS.has(kind) && !SECRET_NAME.test(name))) continue;
      if (!senders.has(name)) senders.set(name, { name, kind, file });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const packages = Object.entries(SENDER_PACKAGES).flatMap(([kind, names]) => names.filter((n) => deps.has(n)).map((name) => ({ name, kind })));
  return { files: examples, senders: [...senders.values()].sort(byName), switches: [...switches.values()].sort(byName), packages: packages.sort(byName) };
}

// On Windows, looking up \\host\share or //host/share contacts that host (invariant 10), so
// such a folder is skipped and said, never looked up.
function local(dir, platform, problems, what) {
  if (!dir) return null;
  if (platform === 'win32' && isNetworkPath(dir)) {
    problems.push(`skipped a network path (${what}): ${dir}`);
    return null;
  }
  return dir;
}

// The executable a name resolves to in these PATH folders (with Windows' extensions), or null.
function onPath(name, dirs, env, platform) {
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not in this folder.
      }
    }
  }
  return null;
}

function androidSdk(env, home, platform, problems) {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === 'darwin' && path.join(home, 'Library', 'Android', 'sdk'),
    platform === 'win32' && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    platform !== 'darwin' && platform !== 'win32' && path.join(home, 'Android', 'Sdk'),
  ];
  return candidates.map((dir) => local(dir, platform, problems, 'the Android SDK')).find((dir) => dir && fs.existsSync(dir)) ?? null;
}

function playwrightDir(env, home, platform) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ms-playwright') : null;
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

// A folder's entries, or [] when it does not exist; any other failure is a problem, so a
// folder that could not be read never reads as an empty one.
function entries(dir, problems, what) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') problems.push(`${what} could not be read (${dir}): ${error.code ?? error.message}`);
    return [];
  }
}

// This machine, for the machine block: what it is, and what a session can run and look at a
// UI with here. Read only; the one command it runs is `xcrun simctl list` on a Mac. Memory is
// a container's limit when it has one, not the host's.
export function machineFacts({ env = process.env, home = os.homedir(), platform = process.platform, memory = { total: os.totalmem(), constrained: process.constrainedMemory?.() } } = {}) {
  const problems = [];
  const tools = {};
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const dirs = pathDirs.map((dir) => local(dir, platform, problems, 'a PATH entry')).filter(Boolean);
  for (const name of MACHINE_TOOLS) {
    const found = onPath(name, dirs, env, platform);
    if (found) tools[name] = found;
  }
  const sdk = androidSdk(env, home, platform, problems);
  if (sdk) {
    const exe = platform === 'win32' ? '.exe' : '';
    for (const [name, rel] of [['adb', path.join('platform-tools', 'adb' + exe)], ['emulator', path.join('emulator', 'emulator' + exe)]]) {
      if (!tools[name] && fs.existsSync(path.join(sdk, rel))) tools[name] = path.join(sdk, rel);
    }
  }
  const avdDir = local(env.ANDROID_AVD_HOME || path.join(home, '.android', 'avd'), platform, problems, 'the Android emulators');
  const androidAvds = avdDir ? entries(avdDir, problems, 'the Android emulators').filter((n) => n.endsWith('.ini')).map((n) => n.slice(0, -4)).sort() : [];
  const browsersDir = local(playwrightDir(env, home, platform), platform, problems, "Playwright's browsers");
  // Playwright writes INSTALLATION_COMPLETE last; a build without it was cut off midway.
  const builds = browsersDir ? entries(browsersDir, problems, "Playwright's browsers").filter((n) => /^(chromium|chromium_headless_shell|chromium-tip-of-tree|firefox|webkit)-\d+$/.test(n)).sort() : [];
  const playwrightBrowsers = builds.filter((n) => fs.existsSync(path.join(browsersDir, n, 'INSTALLATION_COMPLETE')));
  for (const n of builds.filter((b) => !playwrightBrowsers.includes(b))) problems.push(`Playwright's ${n} has no INSTALLATION_COMPLETE: its install did not finish`);

  let iosSimulators = [];
  if (platform === 'darwin' && tools.xcrun) {
    const result = spawnSync(tools.xcrun, ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8', timeout: SIMCTL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    try {
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`));
      const runtimes = JSON.parse(result.stdout).devices ?? {};
      iosSimulators = unique(Object.values(runtimes).flat().filter((d) => d.isAvailable !== false).map((d) => d.name)).sort();
    } catch (error) {
      problems.push(`the iOS simulators could not be listed (xcrun simctl list): ${error.message.slice(0, 200)}`);
    }
  }

  return {
    os: { platform, release: os.release(), arch: os.arch() },
    cpus: os.cpus().length,
    memoryGB: Math.round((memory.constrained > 0 && memory.constrained < memory.total ? memory.constrained : memory.total) / 1024 ** 3),
    tools,
    androidSdk: sdk,
    androidAvds,
    playwrightBrowsersDir: browsersDir,
    playwrightBrowsers,
    iosSimulators,
    problems,
  };
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
    outward: outwardFacts(repo, files, deps, problems),
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
    (f) => f.path && pathKey(f.path) !== pathKey(root) && fs.existsSync(path.join(f.path, '.git')) && !repoDirs.some((d) => pathKey(d) === pathKey(f.path)),
  );
  const rootSettings = ['settings.json', 'settings.local.json'].map((n) => ({ file: `.claude/${n}`, json: readJson(path.join(root, '.claude', n)) })).filter((s) => s.json);
  return {
    root: posix(root),
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    machine: machineFacts(),
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
