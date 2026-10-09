// What setup learns about this machine and about what a local run could send for real, and
// the rules that use it: the machine block, UI changes looked at running, and local runs that
// reach real people. Against throwaway folders; nothing here reads the real home folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as survey from '../scripts/lib/survey.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'fake tools are shell scripts' : false };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-machine-'));
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function tool(dir, name, script = 'exit 0') {
  write(path.join(dir, name), `#!/bin/sh\n${script}\n`);
  fs.chmodSync(path.join(dir, name), 0o755);
}
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
}

test('the survey reports this machine: OS, memory, browser and device tools, emulators and Playwright builds', POSIX_ONLY, () => {
  const home = tempDir();
  const bin = tempDir();
  const browsers = tempDir();
  tool(bin, 'agent-device');
  tool(bin, 'docker');
  write(path.join(home, '.android', 'avd', 'Pixel_Test.ini'), 'avd.ini.encoding=UTF-8\n');
  fs.mkdirSync(path.join(home, '.android', 'avd', 'Pixel_Test.avd'), { recursive: true });
  for (const name of ['chromium-1234', 'chromium_headless_shell-1234', 'webkit-2336', 'ffmpeg-1011']) write(path.join(browsers, name, 'INSTALLATION_COMPLETE'), '');
  fs.mkdirSync(path.join(browsers, '.links'));

  const facts = survey.machineFacts({ env: { PATH: bin, PLAYWRIGHT_BROWSERS_PATH: browsers }, home, platform: 'linux' });
  assert.equal(facts.os.platform, 'linux');
  assert.ok(facts.cpus >= 1, 'it counts the cores');
  assert.ok(facts.memoryGB > 0, 'it reports the memory');
  assert.equal(facts.tools['agent-device'], path.join(bin, 'agent-device'));
  assert.equal(facts.tools.docker, path.join(bin, 'docker'));
  assert.equal(facts.tools.maestro, undefined, 'a tool that is not installed is left out');
  assert.deepEqual(facts.androidAvds, ['Pixel_Test']);
  assert.deepEqual(facts.playwrightBrowsers, ['chromium-1234', 'chromium_headless_shell-1234', 'webkit-2336']);
  assert.deepEqual(facts.iosSimulators, [], 'no simulators off a Mac');
  assert.deepEqual(facts.problems, []);
});

test('the Android SDK is found where its installer puts it, even when its tools are not on PATH', POSIX_ONLY, () => {
  const home = tempDir();
  tool(path.join(home, 'Android', 'Sdk', 'platform-tools'), 'adb');
  tool(path.join(home, 'Android', 'Sdk', 'emulator'), 'emulator');
  const facts = survey.machineFacts({ env: { PATH: tempDir() }, home, platform: 'linux' });
  assert.equal(facts.androidSdk, path.join(home, 'Android', 'Sdk'));
  assert.equal(facts.tools.adb, path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));
  assert.equal(facts.tools.emulator, path.join(home, 'Android', 'Sdk', 'emulator', 'emulator'));
});

test('iOS simulators are listed on a Mac, and a listing that fails is a problem, never "none"', POSIX_ONLY, () => {
  const home = tempDir();
  const bin = tempDir();
  const devices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{ name: 'iPhone 16', isAvailable: true }, { name: 'iPhone 16', isAvailable: true }, { name: 'iPad Air', isAvailable: true }] } };
  tool(bin, 'xcrun', `printf '%s' '${JSON.stringify(devices)}'`);
  const ok = survey.machineFacts({ env: { PATH: bin }, home, platform: 'darwin' });
  assert.deepEqual(ok.iosSimulators, ['iPad Air', 'iPhone 16']);
  assert.deepEqual(ok.problems, []);

  tool(bin, 'xcrun', 'echo "simctl broke" >&2; exit 3');
  const failed = survey.machineFacts({ env: { PATH: bin }, home, platform: 'darwin' });
  assert.deepEqual(failed.iosSimulators, []);
  assert.match(failed.problems.join('\n'), /simulators could not be listed/);
});

test('the survey lists what a local run could send for real: names from tracked example env files, never values', () => {
  const root = tempDir();
  const repo = path.join(root, 'api');
  gitRepo(repo);
  write(
    path.join(repo, '.env.example'),
    [
      'DATABASE_URL=postgres://user:hunter2@db.internal/app',
      'RESEND_API_KEY=re_value_that_must_not_leak',
      'TWILIO_AUTH_TOKEN=',
      'export STRIPE_SECRET_KEY=sk_value_that_must_not_leak',
      '# PUBLISH_SKIP_CRON=true',
      'SLACK_WEBHOOK_URL=https://hooks.example/value-that-must-not-leak',
      'APP_NAME=demo',
    ].join('\n'),
  );
  write(path.join(repo, 'apps', 'web', '.env.sample'), 'ONESIGNAL_API_KEY=x\nEMAIL_DRY_RUN=true\n');
  write(path.join(repo, '.env.local'), 'SENDGRID_API_KEY=SG.value_that_must_not_leak\n');
  write(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { nodemailer: '^6', express: '^4' } }));
  execFileSync('git', ['-C', repo, 'add', '.env.example', 'apps/web/.env.sample', 'package.json']);

  const result = survey.surveyWorkspace(root);
  const outward = result.repos.find((r) => r.name === 'api').outward;
  assert.deepEqual(outward.files, ['.env.example', 'apps/web/.env.sample']);
  assert.deepEqual(
    outward.senders.map((s) => `${s.name}:${s.kind}`),
    ['ONESIGNAL_API_KEY:push', 'RESEND_API_KEY:email', 'SLACK_WEBHOOK_URL:chat', 'STRIPE_SECRET_KEY:payments', 'TWILIO_AUTH_TOKEN:sms'],
  );
  assert.deepEqual(outward.switches.map((s) => s.name), ['EMAIL_DRY_RUN', 'PUBLISH_SKIP_CRON']);
  assert.deepEqual(outward.packages, [{ name: 'nodemailer', kind: 'email' }]);
  const text = JSON.stringify(result);
  for (const value of ['hunter2', 're_value_that_must_not_leak', 'sk_value_that_must_not_leak', 'value-that-must-not-leak', 'SG.value_that_must_not_leak', 'SENDGRID']) {
    assert.ok(!text.includes(value), `the survey never carries "${value}" (values, and names from untracked env files)`);
  }
  assert.ok(result.machine && result.machine.os, 'the workspace survey carries the machine facts');
});

test('the machine block is a managed block, written where teammates never share it', () => {
  const block = fs.readFileSync(path.join(ROOT, 'skills/setup-first-pass/assets/machine-block.md'), 'utf8');
  assert.equal(block.match(/first-pass:machine:start/g).length, 1);
  assert.equal(block.match(/first-pass:machine:end/g).length, 1);
  assert.match(block, new RegExp(`first-pass:machine:start v${VERSION.replace(/\./g, '\\.')} `), 'it carries the plugin version');
  for (const slot of ['{{machine}}', '{{heavy_runs}}', '{{limits}}', '{{ui_tools}}']) assert.ok(block.includes(slot), `it has ${slot}`);
  const ci = read('.github/workflows/validate.yml');
  assert.match(ci, /for block in rules profile words machine workspace project; do/, 'CI checks its markers');
  assert.match(ci, /for block in rules profile words machine; do/, 'CI checks its version');
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /`machine-block\.md`/, 'setup copies it');
  assert.match(setup, /The machine block never goes in a file teammates share/, 'setup keeps it out of shared files');
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), /the machine block/, 'the reviewer reads it');
});

test('UI changes are looked at running, with the repo section saying how and the machine block saying with what', () => {
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /\*\*UI changes are looked at running\.\*\* A change to what a screen shows or how it behaves is looked at running before it is called done/);
  assert.match(rules, /"Not checked: the UI was not looked at running"/, 'no way to look is said, not skipped');
  const project = read('skills/setup-first-pass/assets/project-block.md');
  assert.match(project, /\*\*Looking at the UI running\*\*.*\{\{ui_check\}\}/, 'each repo says how its screens are looked at');
  const ship = read('skills/ship-check/SKILL.md');
  assert.match(ship, /\*\*Look at the UI running\.\*\*/, 'ship-check walks it');
  assert.match(ship, /UI looked at running: </, 'ship-check reports it');
  assert.match(read('skills/review/SKILL.md'), /Look at it running with the repo's UI check and the browsers and devices the machine block names/, 'the review uses it');
});

test('heavy runs follow the machine block, and the standing yes never covers a local run that reaches real people', () => {
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /\*\*Heavy runs follow the machine block\.\*\*/);
  assert.match(rules, /A test runner's timeout is not a kill/);
  assert.match(rules, /never covers a local run that reaches real people \(email, SMS, push, payments, publishing to real accounts\)/);
  const project = read('skills/setup-first-pass/assets/project-block.md');
  assert.match(project, /\*\*Local runs that reach real people\*\*.*\{\{outward\}\}/, 'each repo lists what to blank first');
  assert.match(project, /\*\*Heavy runs\*\*[^{]*\{\{heavy_runs\}\}/, 'the repo keeps its own heavy runs');
  assert.match(read('skills/ship-check/SKILL.md'), /a local run that reaches real people waits for the user's yes, unless it runs with the keys and switches its section lists set, setting them stops it, and the section does not say it needs a yes/);
  const readme = read('README.md');
  const minor = JSON.parse(read('.claude-plugin/plugin.json')).version.split('.').slice(0, 2).join('\\.');
  assert.match(readme, new RegExp(`This is version ${minor},`), 'the README names the version plugin.json has');
  assert.match(readme, /the machine block/, 'the README says what the machine block is');
});

test('the machine-wide heavy-run answer carries its own exception, says it is machine-wide, and has a fallback when no block loads', () => {
  assert.match(read('skills/setup-first-pass/assets/machine-block.md'), /never covers a local run that reaches real people/, 'the block carries the exception itself');
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /the answer applies in every project on this machine/, 'the question says it is machine-wide');
  assert.match(setup, /show the owner the answer it holds now before replacing it/, 'an existing answer is shown before it is replaced');
  assert.match(setup, /`\$CLAUDE_CONFIG_DIR\/CLAUDE\.md` when `CLAUDE_CONFIG_DIR` is set/, 'the block follows CLAUDE_CONFIG_DIR, as the start-of-session check does');
  assert.match(setup, /only Claude Code loads it/, 'the report says which tools miss it');
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), /With no machine block loaded, ask before each heavy run/, 'a session with no block still has an answer');
});

test('the macOS recipe works in the zsh Claude Code runs commands in', () => {
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /bash -c 'set -m; \( <command> \) > <log> 2>&1 < \/dev\/null & echo \$!'/, 'the job gets its own process group through bash, its output in a log, and a pipeline stays one group led by the printed id (verified from zsh)');
  assert.doesNotMatch(setup, /process group \(`set -m`\)/, 'no bare set -m, which zsh -c refuses');
});

test('a key left empty is not a stop when the SDK falls back to the machine\'s own login, and no example file means unknown', () => {
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /falls back to the machine's own login/);
  assert.match(setup, /AWS SDK[^.]*~\/\.aws\/credentials/);
  assert.match(setup, /`firebase-admin`[^.]*Google login/);
  assert.match(setup, /a repo that commits no example env file gets "unknown: /);
});

test('mail settings, prefixed vendor names and more example file names are found, and every example file is read', () => {
  const root = tempDir();
  const repo = path.join(root, 'app');
  gitRepo(repo);
  write(
    path.join(repo, 'env.example'),
    ['MAIL_MAILER=smtp', 'MAIL_HOST=smtp.example', 'MAIL_PASSWORD=', 'EMAIL_HOST=', 'EMAIL_HOST_PASSWORD=', 'EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend', 'APP_SENDGRID_API_KEY=', 'NOTIFY_TWILIO_AUTH_TOKEN=', 'FIREBASE_PRIVATE_KEY=', 'FIREBASE_API_KEY=public'].join('\n'),
  );
  write(path.join(repo, '.env.local.template'), 'POSTMARK_SERVER_TOKEN=\n');
  for (let i = 0; i < 11; i++) write(path.join(repo, 'pkgs', `p${String(i).padStart(2, '0')}`, '.env.example'), i === 10 ? 'PLIVO_AUTH_TOKEN=\n' : 'APP_NAME=x\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const result = survey.surveyWorkspace(root).repos.find((r) => r.name === 'app');
  const senders = result.outward.senders.map((s) => `${s.name}:${s.kind}`);
  for (const want of ['PLIVO_AUTH_TOKEN:sms', 'MAIL_HOST:email', 'MAIL_PASSWORD:email', 'EMAIL_HOST:email', 'EMAIL_HOST_PASSWORD:email', 'APP_SENDGRID_API_KEY:email', 'NOTIFY_TWILIO_AUTH_TOKEN:sms', 'FIREBASE_PRIVATE_KEY:push', 'POSTMARK_SERVER_TOKEN:email']) {
    assert.ok(senders.includes(want), `finds ${want}`);
  }
  assert.ok(!senders.some((s) => s.startsWith('FIREBASE_API_KEY')), 'a public Firebase web key is not a sender');
  assert.deepEqual(result.outward.switches.map((s) => s.name), ['EMAIL_BACKEND', 'MAIL_MAILER']);
  assert.equal(result.outward.files.length, 13, 'every example env file is read, the thirteenth too');
});

test('on Windows the survey never looks up a network path (each lookup contacts that host)', () => {
  const looked = [];
  const originals = { statSync: fs.statSync, existsSync: fs.existsSync, readdirSync: fs.readdirSync };
  for (const name of Object.keys(originals)) {
    fs[name] = (p, ...rest) => {
      looked.push(String(p));
      return originals[name](p, ...rest);
    };
  }
  let facts;
  try {
    facts = survey.machineFacts({
      env: { PATH: '\\\\fileserver\\tools\\bin;//fileserver/more', ANDROID_HOME: '\\\\fileserver\\sdk', ANDROID_AVD_HOME: '\\\\fileserver\\avd', PLAYWRIGHT_BROWSERS_PATH: '//fileserver/pw' },
      home: tempDir(),
      platform: 'win32',
    });
  } finally {
    Object.assign(fs, originals);
  }
  const network = looked.filter((p) => /^[\\/]{2}/.test(p));
  assert.deepEqual(network, [], 'no network path is looked up');
  assert.match(facts.problems.join('\n'), /network path/, 'what was skipped is said');
});

test('memory is the container\'s limit when there is one', () => {
  const home = tempDir();
  const GB = 1024 ** 3;
  assert.equal(survey.machineFacts({ env: { PATH: '' }, home, platform: 'linux', memory: { total: 64 * GB, constrained: 8 * GB } }).memoryGB, 8);
  assert.equal(survey.machineFacts({ env: { PATH: '' }, home, platform: 'linux', memory: { total: 64 * GB, constrained: 0 } }).memoryGB, 64);
});

test('where the real-people line is unknown or missing, only runs that could send ask first, and setup offers the line', () => {
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /In a repo whose "Local runs that reach real people" line says "unknown", that has no such line, or that has no first-pass section, any server, worker or end-to-end or integration run counts as one and asks first, whatever keys are set\./, 'in such a repo these always ask, whatever keys are blanked');
  assert.match(rules, /There, format, lint, typecheck, unit tests and builds don't count as one, unless the section names them as reaching real people\./, 'the carve-out is scoped to such repos');
  assert.doesNotMatch(rules, /Format, lint, typecheck, unit tests and builds follow the heavy-run answer/, 'no unscoped carve-out that could outrank "never covers a run that reaches real people"');
  assert.match(read('skills/setup-first-pass/assets/machine-block.md'), /a repo whose "Local runs that reach real people" line says "unknown", that has no such line, or that has no first-pass section asks before a server, a worker or an end-to-end or integration run/, 'the machine-wide yes carries it');
  const breakerText = read('skills/setup-first-pass/assets/breaker.md');
  assert.match(breakerText, /In a repo whose "Local runs that reach real people" line says "unknown", that has no such line, or that has no first-pass section, any server, worker or end-to-end or integration run counts as one, so you don't start it there, and you say what you didn't run\./, 'the reviewer, who cannot ask, runs none of them');
  assert.match(breakerText, /There, format and lint checks \(never a command that rewrites files\), typecheck and unit tests you may still run within the repo's test limits, unless its section names them as reaching real people; a build only where the machine block's heavy-run answer is a standing yes\./, 'the reviewer runs checks, never rewrites, and builds only on a standing yes');
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /"None found" only when the survey and a read of the code show none \(a library or a CLI that sends nothing\); otherwise a repo that commits no example env file gets "unknown: /, 'none found and unknown cannot both apply');
  assert.match(setup, /Local runs that reach real people: <per repo: the senders and what to set first, "none found", or "unknown: <what to check>">/, 'the report offers unknown');
  assert.match(setup, /offer to add the drafted line, with the owner's yes/, 'an older section gets the line offered, not only reported');
  assert.match(setup, /until it is added, servers, workers and end-to-end or integration runs in that repo ask first/, 'the report says what holds until then');
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /\*\*Local runs that reach real people\*\*/, "first-pass's own section has the line");
});

test('a run its section says needs a yes asks, and every place says which runs ask in a repo with an unknown or missing line', () => {
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  assert.match(rules, /Such a run asks first, unless it runs with the keys and switches its repo's section lists set, setting them stops it, and the section does not say it needs a yes\./, 'the keys must be set and must stop it');
  assert.doesNotMatch(rules, /nothing the section names stops|or that none of the keys and switches it names stop/, 'no wording that can stand alone and catch every run');
  assert.match(read('skills/setup-first-pass/assets/machine-block.md'), /the section does not say it needs a yes/, 'the machine block keeps the needs-a-yes case');
  const breaker = read('skills/setup-first-pass/assets/breaker.md');
  assert.match(breaker, /A local run that reaches real people \(email, SMS, push, payments, publishing\) you start only when it runs with the keys and switches the repo's section lists set, setting them stops it, and the section does not say it needs a yes\./, 'the reviewer: the keys must be set and must stop it');
  assert.doesNotMatch(breaker, /nothing it names stops|or that none of the keys and switches it names stop/, 'no wording that can stand alone');
  const clause = /except a server, a worker or an end-to-end or integration run in a repo with no first-pass section, or whose real-people line says "unknown" or is missing, which asks first/;
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /Say that the answer applies in every project on this machine,? except a server/, 'step 2 says it');
  assert.match(setup, clause, 'setup carries the clause');
  assert.match(setup, /Machine: <[^>]*>; heavy runs <the answer, except a server, a worker or an end-to-end or integration run in a repo with no first-pass section, or whose real-people line says "unknown" or is missing, which asks first>/, 'the report carries it');
  assert.match(read('README.md'), clause, 'the README carries it');
  assert.match(setup, /which the rules make ask before a server, a worker or an end-to-end or integration run/, 'unknown is described as the rules apply it');
  assert.match(setup, /servers, workers and end-to-end or integration runs in that repo ask first/, 'the owner is told the same set the rules enforce');
  assert.match(setup, /a drafted "unknown" line keeps them asking/, 'adding an unknown line is not sold as ending the asks');
});

test('the survey stays fast on a whitespace-only line and reads example env files at any depth', () => {
  const root = tempDir();
  const repo = path.join(root, 'svc');
  gitRepo(repo);
  write(path.join(repo, '.env.example'), ' '.repeat(64 * 1024) + '\nRESEND_API_KEY=\n');
  write(path.join(repo, 'apps', 'api', 'src', 'config', '.env.example'), 'SENDGRID_API_KEY=\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const started = Date.now();
  const facts = survey.surveyRepo(repo, root);
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `a 64 KB whitespace line took ${ms} ms`);
  const names = facts.outward.senders.map((s) => s.name);
  assert.ok(names.includes('RESEND_API_KEY'), 'the line after it is still read');
  assert.ok(names.includes('SENDGRID_API_KEY'), 'an example env file five folders deep is read');
});

test('public keys, test logins and generic names are not senders; framework mailer settings are', () => {
  const root = tempDir();
  const repo = path.join(root, 'web');
  gitRepo(repo);
  const notSenders = ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'VITE_STRIPE_PUBLIC_KEY', 'EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'PUBLIC_KNOCK_API_KEY', 'STRIPE_PUBLISHABLE_KEY', 'EMAIL_VERIFICATION_SECRET', 'ADMIN_EMAIL_PASSWORD', 'E2E_EMAIL_PASSWORD', 'IMAP_EMAIL_PASSWORD', 'WORKER_THREADS_KEY', 'X_API_KEY', 'EXPO_ACCESS_TOKEN'];
  const senders = ['REACT_APP_SENDGRID_KEY', 'STRIPE_SECRET_KEY', 'EMAIL_HOST_PASSWORD', 'MAIL_PASSWORD', 'APP_SENDGRID_API_KEY', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'MAILER_DSN', 'MAILER_HOST', 'MAILER_PASSWORD'];
  write(path.join(repo, '.env.example'), [...notSenders, ...senders].map((n) => `${n}=`).join('\n') + '\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const found = survey.surveyRepo(repo, root).outward.senders.map((s) => s.name);
  for (const name of notSenders) assert.ok(!found.includes(name), `${name} is not a sender`);
  for (const name of senders) assert.ok(found.includes(name), `${name} is a sender`);
});

test('mail settings with a middle word, X\'s posting keys and secrets behind a public prefix are senders', () => {
  const root = tempDir();
  const repo = path.join(root, 'app');
  gitRepo(repo);
  const notSenders = ['X_API_KEY', 'X_CLIENT_ID', 'X_REDIRECT_URI', 'X_ANALYTICS_ENABLED', 'EMAIL_VERIFICATION_URL', 'EMAIL_FROM', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_REVENUECAT_IOS_KEY', 'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN', 'PUBLIC_KNOCK_API_KEY'];
  const senders = {
    EMAIL_SERVER: 'email', EMAIL_SERVER_HOST: 'email', EMAIL_SERVER_PASSWORD: 'email', EMAIL_API_TOKEN: 'email', EMAIL_PROVIDER_API_KEY: 'email', MAIL_SECRET: 'email', MAIL_KEY: 'email',
    EMAIL_APP_PASSWORD: 'email', GMAIL_APP_PASSWORD: 'email', GMAIL_PASS: 'email', NODEMAILER_PASS: 'email',
    X_API_BEARER_TOKEN: 'publishing', X_CLIENT_SECRET: 'publishing', X_ACCESS_TOKEN: 'publishing', X_ACCESS_TOKEN_SECRET: 'publishing', X_CONSUMER_SECRET: 'publishing',
    X_ACCESS_SECRET: 'publishing', X_APP_KEY: 'publishing', X_APP_SECRET: 'publishing', X_API_SECRET_KEY: 'publishing', X_OAUTH2_CLIENT_SECRET: 'publishing', X_REFRESH_TOKEN: 'publishing',
    NEXT_PUBLIC_DISCORD_WEBHOOK_URL: 'chat', VITE_SLACK_WEBHOOK_URL: 'chat', EXPO_PUBLIC_TWILIO_AUTH_TOKEN: 'sms', NEXT_PUBLIC_STRIPE_SECRET_KEY: 'payments',
    // Email, SMS and chat vendors have no public keys: any key of theirs in a bundle sends.
    NEXT_PUBLIC_RESEND_API_KEY: 'email', VITE_SENDGRID_API_KEY: 'email', VITE_TELEGRAM_BOT_TOKEN: 'chat', NEXT_PUBLIC_SLACK_BOT_TOKEN: 'chat', REACT_APP_DISCORD_BOT_TOKEN: 'chat',
    VITE_TWILIO_API_KEY: 'sms', EXPO_PUBLIC_ONESIGNAL_REST_API_KEY: 'push', NEXT_PUBLIC_FACEBOOK_APP_SECRET: 'publishing',
  };
  write(path.join(repo, '.env.example'), [...notSenders, ...Object.keys(senders)].map((n) => `${n}=`).join('\n') + '\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const found = Object.fromEntries(survey.surveyRepo(repo, root).outward.senders.map((s) => [s.name, s.kind]));
  for (const name of notSenders) assert.ok(!(name in found), `${name} is not a sender`);
  for (const [name, kind] of Object.entries(senders)) assert.equal(found[name], kind, `${name} is a ${kind} sender`);
});

test('the machine block holds the run limits the parts runner follows, and parts never send for real without the yes', () => {
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /`partWrapper` \(only when the machine block's heavy-run answer names a wrapper heavy runs must go through, such as a memory-capped runner; the block holds the answer, and this copies it: when the two differ, after a hand edit or a setup run in another folder, show the owner both and write the one they keep in both places\)/, 'the wrapper is copied from the machine block');
  assert.match(setup, /This block is where that answer lives: a wrapper named here is the one a main folder's `partWrapper` copies \(step 4\), and a limit on how many heavy runs go at once binds the parts runner too/);
  assert.match(setup, /A part that starts a server, a worker or an end-to-end or integration run sets, in its `env`, every key and switch the project block's "Local runs that reach real people" line says to set \(a key as `""`\), and its `envFile` `keys` never name one of them/, 'drafted recipes blank the keys');
  const ship = read('skills/ship-check/SKILL.md');
  assert.match(ship, /Step 4's first paragraph, on runs that reach real people, holds for each part\. Before `all`, read the recipe: a part that starts a server, a worker or an end-to-end or integration run without the keys and switches the repo's section lists set in its `env`, or whose steps' or server's own `env` \(applied after the part's, so it wins\) sets one of them, or that reads one of them through its `envFile`, waits for the user's yes, and so does every such part in a repo whose real-people line says "unknown" or is missing, whatever the recipe sets/);
  assert.match(ship, /When the machine block limits how many heavy runs go at once, run the parts by name, one stage at a time and within that limit, instead of `all`/);
});

test('when a UI cannot be looked at here, setup and every report say what to install, and nothing is installed without a yes', () => {
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /for each UI repo, what is missing to look at it running here, each with its install command, and ask which to install/);
  assert.match(setup, /Take each command from the tool's current docs, never from memory\. Install only what the owner says yes to, one at a time, then run the survey again/);
  assert.match(setup, /"Missing:" and, for each UI repo, what step 2 found missing and the owner did not install, with its install command/);
  const say = /"Not checked: the UI was not looked at running", why, and what to install to look \(the machine block's "Missing:" line, or the tool's current docs\)/;
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), say);
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), /installed only with the user's yes/);
  assert.match(read('skills/ship-check/SKILL.md'), say);
  assert.match(read('skills/ship-check/SKILL.md'), /install it only with the user's yes/);
  assert.match(read('skills/review/SKILL.md'), /when this machine lacks the tool, what to install, from the machine block's "Missing:" line, installed only with the user's yes/);
});

test('a Playwright build counts only once its install finished, and a half-finished one is said', POSIX_ONLY, () => {
  const browsers = tempDir();
  write(path.join(browsers, 'chromium-1234', 'INSTALLATION_COMPLETE'), '');
  fs.mkdirSync(path.join(browsers, 'chromium-1300', 'chrome-mac'), { recursive: true });
  const facts = survey.machineFacts({ env: { PATH: tempDir(), PLAYWRIGHT_BROWSERS_PATH: browsers }, home: tempDir(), platform: 'linux' });
  assert.deepEqual(facts.playwrightBrowsers, ['chromium-1234'], 'an install killed midway is not a browser');
  assert.ok(facts.problems.some((p) => p.includes('chromium-1300')), 'and it is named as a problem');
});

test('install hints fetch the build the repo drives, and say how to look with what is installed', () => {
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /run in the package that depends on Playwright, with its dependencies installed \(otherwise `npx` fetches the newest Playwright, whose build that repo's tests don't drive\); its `--dry-run` says which build that is/);
  assert.match(setup, /on Linux, `--with-deps` when the browser cannot start for missing system libraries \(it installs them with `sudo`\)/);
  assert.match(setup, /a web repo with no browser tests: Playwright's Chromium \(`npx playwright install chromium`\), then a session looks with `npx playwright screenshot <url> <file>` \(`--device "iPhone 13"` for a phone width\)/);
});

test('without a partWrapper, a machine block wrapper still caps every part', () => {
  assert.match(read('skills/ship-check/SKILL.md'), /When the machine block names a wrapper but `parts <repo> check` says "no partWrapper" \(one repo with no main folder, or a main folder set up before the wrapper\), run each part by name, one at a time, inside that wrapper, as every heavy run goes; never `all` uncapped/);
  assert.match(read('README.md'), /a wrapper named there is the one the parts runner starts each part through in a main folder/);
});

test('a blank key holds only when nothing in the run puts the real one back, in every run ship-check makes', () => {
  const ship = read('skills/ship-check/SKILL.md');
  const step4 = ship.slice(ship.indexOf('## 4. CI'), ship.indexOf('When the repo has `.first-pass/parts.json`'));
  assert.match(step4, /The keys and switches stop a run only when nothing in it puts the real ones back, so such a run also waits for the yes unless each of these holds \(/, 'step 4 says it for every run, not only parts');
  assert.match(step4, /no real env file that holds one of those keys or switches is in the worktree while it goes \(one copied in for an earlier run included\); it gets what else it needs from a copy with those keys and switches taken out \(made, then checked, as the Secrets rule says\), or a recipe's `envFile` keys/, 'presence, not copying, and a way for repos with no recipe');
  assert.match(step4, /its commands load no env file themselves \(`env-cmd`, dotenv with `override`, `set -a; \. <file>`, a compose `env_file`\) that sets one of them/);
  assert.match(step4, /a public-prefixed one among them \(`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_` and the like\) is empty in the build of the app it serves too, since a build bakes it in/);
  assert.match(step4, /it starts every server it talks to: never one already running \(the user's own dev server, loaded with the real keys\); where its config would reuse one \(Playwright's `reuseExistingServer`\), make it start its own/);
  assert.match(ship, /A run here that could reach real people follows step 4's first paragraph, env files included/, 'step 2 points at it');
  assert.match(ship, /A run here that could reach real people \(a dev server, an app, or a UI check that may reuse a server already running\) follows step 4's first paragraph/, 'and so does looking at the UI');
  assert.match(ship, /any leftovers, including env files copied in for runs that send nothing/);
  assert.match(ship, /or whose steps' or server's own `env` \(applied after the part's, so it wins\) sets one of them, or that reads one of them through its `envFile`, waits for the user's yes/, 'the parts check reads step and server env as a check, not a promise');
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /and its `envFile` `keys` never name one of them; neither does a step's or server's own `env`, which is applied after the part's\. The part's `env` wins over the env file the runner reads and over the shell's own environment, never over an env file the part's own commands load/);
  assert.match(setup, /A part that builds what such a part serves sets the public-prefixed ones among them \(`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`\) the same way, since a build bakes them in/);
  assert.match(step4, /unless each of these holds \(every env file below is checked and copied as the Secrets rule says: no value is read into the session or printed, and a copy goes from the filter straight into its file\):/, 'every env-file check follows the Secrets rule');
  const names = /An env file that holds keys is never opened with a file tool, printed, or searched with a command that prints its lines: check it with `grep -cE` or `grep -lE` and a pattern of the names \(`'\^\[\[:space:\]\]\*\(export\[\[:space:\]\]\+\)\?\(NAME_A\|NAME_B\)\[\[:space:\]\]\*\[=:\]'`\), which print only a count or a file name; make a copy without those names with `grep -vE '<that pattern>' <file> > <copy>`, then check the copy the same way\. A search across a repo skips env files \(`--exclude='\.env\*'`\)/;
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), names, 'the Secrets rule says it for every session');
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), names, 'and the reviewer');
  assert.match(read('skills/setup-first-pass/assets/profile-block.md'), /not `cat`, `sed` or heredocs \(an env file that holds keys is the exception: the Secrets rule says how it is read\)/, 'the file-tools rule makes room for it');
  assert.match(read('skills/premortem/SKILL.md'), /grep -rn --exclude='\.env\*' "<queue_or_event_name>"/, 'the pre-mortem\'s searches skip env files');
  const backs = /Setting them stops it only when nothing in the run puts the real ones back: an env file its own commands load, an app built with the real ones, or a server it talks to but did not start \(a test runner may reuse one already running: Playwright's `reuseExistingServer`\)/;
  assert.match(read('skills/setup-first-pass/assets/rules-block.md'), backs, 'the rules say it for every session');
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), backs, 'and the reviewer');
});

test('the env file commands the Secrets rule names, run as written, never print a value and find every key', POSIX_ONLY, () => {
  const rule = read('skills/setup-first-pass/assets/rules-block.md');
  const [, count, list] = /check it with `(grep -[A-Za-z]+)` or `(grep -[A-Za-z]+)`/.exec(rule);
  const strip = /make a copy without those names with `(grep -[A-Za-z]+) '<that pattern>'/.exec(rule)[1];
  const pattern = /a pattern of the names \(`'([^`]+)'`\)/.exec(rule)[1].replace('NAME_A|NAME_B', 'RESEND_API_KEY|BIRD_API_KEY|STRIPE_KEY');
  const dir = tempDir();
  const env = path.join(dir, '.env.local');
  const copy = path.join(dir, 'copy.env');
  fs.writeFileSync(env, ['export RESEND_API_KEY=re_live_AAA', 'BIRD_API_KEY = bird_BBB', 'STRIPE_KEY: sk_live_CCC', '# old prod key sk_live_DDD', 'PRIVATE_KEY="-----BEGIN KEY-----', 'xYz0123secretbody==', '-----END KEY-----"', 'DATABASE_URL=postgres://u:pw_EEE@localhost/db', ''].join('\n'));
  const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
  const counted = sh(`${count} '${pattern}' '${env}' || true`);
  const listed = sh(`${list} '${pattern}' '${env}' || true`);
  sh(`${strip} '${pattern}' '${env}' > '${copy}'`);
  const recounted = sh(`${count} '${pattern}' '${copy}' || true`);
  for (const secret of ['AAA', 'BBB', 'CCC', 'DDD', 'secretbody', 'EEE']) assert.ok(!(counted + listed + recounted).includes(secret), `${secret} never reaches the output`);
  assert.equal(counted.trim(), '3', 'the check, as written, finds every form of the names');
  assert.equal(listed.trim(), env, 'the list, as written, names the file');
  assert.equal(recounted.trim(), '0', 'the copy holds none of them');
  assert.match(fs.readFileSync(copy, 'utf8'), /^DATABASE_URL=/m, 'and keeps what else the run needs');
});

test('the pre-mortem\'s searches, run as written, skip env files and keep to the file types they name', POSIX_ONLY, () => {
  const lines = read('skills/premortem/SKILL.md').match(/grep -rn [^\n]*?<repo>/g);
  const dir = tempDir();
  for (const [file, text] of [['a.ts', 'field_x\n'], ['README.md', 'field_x\n'], ['.env.local', 'field_x=VAL_SECRET\n']]) fs.writeFileSync(path.join(dir, file), text);
  const typed = lines.find((l) => l.includes('--include')).replace('"<column_or_field>"', 'field_x').replace('*.<ext>', '*.ts').replace(/<repo>.*$/, `'${dir}'`);
  const out = execFileSync('bash', ['-c', `${typed} || true`], { encoding: 'utf8' });
  assert.match(out, /a\.ts/);
  assert.doesNotMatch(out, /README|VAL_SECRET/, 'only the named file type, never an env file');
  const plain = lines.find((l) => l.includes('<queue_or_event_name>')).replace('"<queue_or_event_name>"', 'field_x').replace(/<repo>.*$/, `'${dir}'`);
  assert.doesNotMatch(execFileSync('bash', ['-c', `${plain} || true`], { encoding: 'utf8' }), /VAL_SECRET/, 'a search with no file type skips env files');
});

test('reviews share the machine block\'s limit on heavy runs, and the wrapper lines agree', () => {
  assert.match(read('skills/review/SKILL.md'), /and the machine block's limit on heavy runs at once, counting your own test runs: give each breaker its share \(how many heavy runs it may start\), none when no share is left/);
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), /when it says nothing and the machine block limits how many heavy runs go at once, start none, and say what you did not run/);
  assert.match(read('skills/ship-check/SKILL.md'), /with a `partWrapper`, start the runner itself directly, never inside that cap; without one, see below/);
});

test('the limit on heavy runs at once counts the reviews beside, and a yes covers one run', () => {
  const rules = read('skills/setup-first-pass/assets/rules-block.md');
  const ship = read('skills/ship-check/SKILL.md');
  for (const [name, text] of [['rules', rules], ['ship-check', ship]]) {
    assert.match(text, /the repo's test limits and the machine block's limit on heavy runs at once allow beside the review/, `${name}: the limit counts runs beside a review`);
    assert.match(text, /how many heavy runs it may start meanwhile/, `${name}: the reviewer is told its share`);
    assert.match(text, /A yes for a run that reaches real people covers that one run: a rerun, after a fix or for the full checks, asks again/, `${name}: one yes, one run`);
  }
  assert.match(read('README.md'), /when your repo's test limits and your machine's limit on heavy runs at once allow both/);
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), /leave them alone, and start no more heavy runs than it says you may/, 'the reviewer keeps to its share');
});

test('ship-check and the Linux recipe follow the same rules as the rest', () => {
  assert.match(read('skills/ship-check/SKILL.md'), /in a repo whose real-people line says "unknown" or is missing, or that has no first-pass section, servers, workers and end-to-end or integration runs wait for the user's yes, whatever keys are set/, 'ship-check step 4 never lets blanked keys stand in for the yes there');
  const setup = read('skills/setup-first-pass/SKILL.md');
  assert.match(setup, /- Linux: [^-]*bash -c 'set -m; \( timeout <n>m bash -c "<command>" \) > <log> 2>&1 < \/dev\/null & echo \$!'/, 'Linux: the deadline wraps the whole command, so it stays in the group, and the command runs in bash');
  assert.match(setup, /[Aa] `timeout` on one part of a pipeline moves that part to a group of its own, out of reach of the kill/, 'and says why');
});

test('every place says the same: keys only stand in for the yes when they are set and stop the run, and the reviewer starts heavy runs only on a standing yes', () => {
  const clause = /runs with the keys and switches (its|the) (repo's )?section lists set, setting them stops it, and the section does not say it needs a yes/;
  for (const file of ['skills/setup-first-pass/assets/rules-block.md', 'skills/setup-first-pass/assets/breaker.md', 'skills/setup-first-pass/assets/machine-block.md', 'skills/ship-check/SKILL.md']) {
    const text = read(file);
    assert.match(text, clause, `${file} carries the condition`);
    assert.doesNotMatch(text, /gets the empty keys and switches its (repo's )?section lists, or/, `${file} has no blank-the-keys-and-go wording`);
  }
  assert.match(read('skills/setup-first-pass/assets/breaker.md'), /and you start a heavy run only where the machine block's heavy-run answer is a standing yes: you can't ask/, 'the reviewer, who cannot ask, starts no heavy run on "ask before each"');
});

test('on Linux, a deadline wrapping the whole command keeps every process where the group kill reaches', { skip: process.platform === 'linux' ? false : 'needs GNU timeout and /proc' }, () => {
  const marker = String(280 + Math.floor(Math.random() * 10)) + '7';
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const running = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') === `sleep\0${marker}\0`;
    } catch {
      return false;
    }
  });
  const id = execFileSync('bash', ['-c', `set -m; ( timeout 60 sh -c 'sleep ${marker} | cat' ) > /dev/null 2>&1 < /dev/null & echo $!`], { encoding: 'utf8' }).trim();
  pause(300);
  assert.equal(running().length, 1, 'the run started');
  process.kill(-Number(id), 'SIGTERM');
  pause(700);
  assert.deepEqual(running(), [], 'nothing is left after the group kill');
});

test('the Linux recipe as setup writes it runs the command in bash, so sourcing the empty keys works', { skip: process.platform === 'linux' ? false : 'needs GNU timeout' }, () => {
  const recipe = /- Linux: [^`]*`(bash -c 'set -m; \( timeout <n>m [^`]*)`/.exec(read('skills/setup-first-pass/SKILL.md'))[1];
  const dir = tempDir();
  const log = path.join(dir, 'run.log');
  const run = (command) => {
    fs.rmSync(log, { force: true });
    const filled = recipe.replace('<n>', '1').replace('<command>', command).replace('<log>', log);
    const id = execFileSync('bash', ['-c', filled.replace(/^bash -c '/, '').replace(/'$/, '')], { encoding: 'utf8' }).trim();
    for (let i = 0; i < 50 && !fs.readFileSync(log, 'utf8').includes('end'); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.match(id, /^\d+$/, 'the recipe prints the group id');
    return fs.readFileSync(log, 'utf8');
  };
  assert.match(run('[[ 1 == 1 ]] && echo bash-ok; echo end'), /bash-ok/, 'bash syntax runs');
  const keys = path.join(dir, 'test.env');
  fs.writeFileSync(keys, 'export MARK=blank-keys-loaded\n');
  assert.match(run(`source ${keys} && printenv MARK; echo end`), /blank-keys-loaded/, 'a sourced env file sets the keys before the run');
});
