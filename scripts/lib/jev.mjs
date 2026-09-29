// The optional Jev judge: asks TypeSafe's decision model about review findings, only when the
// user set it up in `<Claude config dir>/first-pass/jev.json`. It is the one part of the plugin
// that makes a network call. Code, not the model, owns the policy: Jev can make a finding real
// harm but never clear one the review named, and a failed, unreadable or unsure answer leaves
// the decision to the rules (verdict "rule"), never to the lighter side.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { isDirectory, isInside, pathKey } from './paths.mjs';
import { redact } from './words.mjs';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const TIMEOUT_MS = 15000;
// One `jev ask` run stops asking after this, under a shell command's usual 2-minute limit.
export const BUDGET_MS = 100000;
export const MAX_FINDINGS = 50;
export const MAX_FIELD_CHARS = 8000;
const CONCURRENCY = 4;
const RETRY_STATUSES = new Set([429, 529]);
// What to check for a refused request, since the server's own text is never printed.
const HINTS = {
  400: 'the request was refused as malformed (check "model" in the config)',
  402: 'out of credit on this key',
  403: 'no access for this key',
  404: 'nothing at that address (check "url" in the config)',
  422: 'the request was refused as malformed (check "model" in the config)',
  429: 'busy; try again later',
  529: 'busy; try again later',
};

// The worst cases that are fixed right away. The same list is in the rules block, ship-check and
// the breaker's report (a test keeps them together).
export const FIX_NOW = {
  money: 'Money: someone loses money, is charged wrongly, or money is spent with no cap.',
  data: 'Data: stored data is lost, overwritten, or leaked to someone who should not see it.',
  twice: 'A side effect (a post, message, email, payment or webhook) happens twice, is sent wrong, or goes out without the yes it needs.',
  security: 'Security: a stranger or another account can do or see something they should not.',
  legal: 'Legal: a legal, privacy, pricing or policy statement becomes false, or a law or platform rule is broken.',
  crash: 'Crash: the app, a server or a job crashes.',
  stuck: 'Stuck: a job never finishes, or a person cannot finish something they started and has no way forward.',
  task: 'The change does not do what it was for.',
};
const SMALL = 'Small: none of the other options. For example words that are wrong in some state, a button that shows when it does nothing, a slower or clumsier path, and nothing is lost, charged, sent or exposed.';
export const WORST_CASES = [...Object.keys(FIX_NOW), 'small'];
export const WHO = {
  everyone: 'anyone using the product in the normal way',
  feature: 'people using one feature or setting',
  unusual: 'only after an unusual order of steps, a race, or an error at the wrong moment',
  nobody: 'nobody today: the code path is switched off or not live',
};
export const PROOFS = {
  checks: "The fix changes only words, labels or layout, and no behaviour and no label's meaning: the repo's format, lint, type and build checks, plus reading the changed text, are enough.",
  unit: 'The fix changes a condition, a calculation or a mapping in code, with no database, queue or outside call: a unit test that fails before the fix and passes after.',
  real: 'The fix changes what is stored or read, a query, a job, a queue or an outside call: a test against the real database or service, the way the repo runs those.',
  browser: 'The fix changes what a page shows or does in a way only a browser shows (loading, focus, navigation, offline): an end-to-end browser test.',
};
// A pick is acted on only above these floors; below, the rules decide. Adding harm needs the
// least certainty; lighter proof needs the most.
export const FLOORS = { harm: 0.5, priority: 0.6, proof: 0.7 };

const QUESTIONS = {
  harm: {
    instructions:
      'Which option describes the worst thing that happens in `finding.scenario`? Pick the option for the worst result the scenario itself states, not what could happen in other cases. Pick small only when the scenario states none of the other results.',
    criteria: { ...FIX_NOW, small: SMALL },
  },
  priority: {
    instructions:
      'Should `finding` be fixed now, or left on a list for later? Use `finding.worst_case` and `finding.who_meets_it`.',
    criteria: {
      fix_now: 'Fix now: people will meet it in normal use, and it shows them something wrong or untrue, or slows or blocks a path they use often.',
      leave_listed: 'Leave it listed: it only shows after an unusual order of steps, a race, or an error at the wrong moment, or on a path nobody uses today.',
    },
  },
  proof: {
    instructions: 'What is the least proof that `finding.the_fix` is right? Pick the option that matches what the fix changes.',
    criteria: PROOFS,
  },
};

export function configPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'first-pass', 'jev.json');
}

function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `"url" is not a URL: ${url}`;
  }
  // The key is sent with every request: only over https, or to this machine (a test server).
  const local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  return parsed.protocol === 'https:' || local ? null : `"url" must be https (the key is sent with it): ${url}`;
}

// The config, or { problem } when it exists but cannot be used, or null when there is none.
export function loadConfig(env = process.env) {
  const file = configPath(env);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (!(error instanceof SyntaxError)) return { file, problem: `${file} cannot be read (${error.code ?? error.name})` };
    // Only where it breaks: the parser's own message quotes the file's text, which could hold a key.
    const at = /position (\d+)/.exec(error.message);
    return { file, problem: `${file} is not valid JSON${at ? ` (near character ${at[1]})` : ''}` };
  }
  const bad = (problem) => ({ file, problem: `${file}: ${problem}` });
  if (!config || typeof config !== 'object' || !Array.isArray(config.keys)) return bad('needs a "keys" list');
  if (config.off !== undefined && typeof config.off !== 'boolean') return bad('"off" must be true or false');
  if (config.model !== undefined && typeof config.model !== 'string') return bad('"model" must be a string');
  if (config.url !== undefined) {
    const problem = typeof config.url === 'string' ? checkUrl(config.url) : '"url" must be a string';
    if (problem) return bad(problem);
  }
  // A key for every other folder next to named ones would give a folder no entry names (a new
  // repo, a checkout somewhere else) whatever account that key belongs to.
  if (config.keys.length > 1 && config.keys.some((entry) => entry?.repos === undefined)) {
    return bad('an entry without "repos" must be the only entry: with separate accounts, name each one\'s repos, so a folder no entry names has the judge off, never another account\'s key');
  }
  for (const [i, entry] of config.keys.entries()) {
    if (!entry || typeof entry.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.env)) return bad(`keys[${i}] needs "env", the name of the variable that holds the key`);
    if (entry.file !== undefined && typeof entry.file !== 'string') return bad(`keys[${i}].file must be a path`);
    if (entry.repos !== undefined && (!Array.isArray(entry.repos) || !entry.repos.every((r) => typeof r === 'string' && path.isAbsolute(r)))) {
      return bad(`keys[${i}].repos must be a list of absolute repo paths`);
    }
  }
  return { ...config, file };
}

const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

// Where git puts `dir`: its own checkout's top folder, and the main checkout that checkout
// belongs to (a worktree, such as a clean checkout in the temp folder, taken back to it); nulls
// outside git. Git runs without any GIT_* the caller's environment holds, so it answers for `dir`.
export function checkouts(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8', env });
  const lines = result.status === 0 ? result.stdout.trim().split(/\r?\n/) : [];
  if (lines.length !== 2 || !path.isAbsolute(lines[0])) return { top: null, main: null };
  // A top that does not hold `dir` (a work tree set by hand elsewhere) is treated as no git, so
  // every step up from here goes strictly up and the search ends.
  const top = real(lines[0]);
  if (!isInside(real(dir), top)) return { top: null, main: null };
  // Older git prints the common folder relative to `dir`. The main checkout holds it as `.git`;
  // anything else (a bare repo, a submodule, a separate git folder) has no main checkout to use.
  const common = path.resolve(dir, lines[1]);
  return { top, main: path.basename(common) === '.git' ? real(path.dirname(common)) : null };
}

// The entry whose `repos` names the deepest folder holding `repo`, and that folder; or nulls.
// Every configured path is compared with links followed, so "deepest wins" holds whichever way
// a path was written.
function namedEntry(config, repo) {
  let entry = null, dir = null;
  for (const candidate of config.keys) {
    for (const configured of candidate.repos ?? []) {
      const d = real(configured);
      if (isInside(repo, d) && (!dir || pathKey(d).length > pathKey(dir).length)) { entry = candidate; dir = d; }
    }
  }
  return { entry, dir };
}

// The entry for `repo`: a named one, else the one with no repos (the default), else none.
export function entryFor(config, repo) {
  return namedEntry(config, repo).entry ?? config.keys.find((entry) => !entry.repos) ?? null;
}

// The folder a key is chosen by, links and junctions followed. A named folder at or inside the
// asked folder's own checkout wins (a named worktree, or a named folder in a repo). Else the same
// place in the main checkout it belongs to, when a name covers that (a worktree, or a subfolder
// of one, gets the key its twin in the main checkout has, even inside a folder named for another
// account). Else the same place under the checkout around this one (a submodule or a nested
// clone inside a worktree). Else a named parent folder, else the default.
export function repoHome(config, dir) {
  const direct = real(dir);
  const own = namedEntry(config, direct);
  const { top, main } = checkouts(direct);
  if (own.entry && (!top || isInside(own.dir, top))) return direct;
  const twin = (home, from) => {
    const place = path.join(home, path.relative(from, direct));
    return namedEntry(config, place).entry ? place : null;
  };
  // Only a worktree has a main checkout other than itself; a repo that is its own main checkout
  // (a nested clone, say) is placed by the checkout around it, below.
  if (main && pathKey(main) !== pathKey(top)) {
    const found = twin(main, top);
    if (found) return found;
  }
  const around = top && path.dirname(top);
  if (around && around !== top) {
    const home = repoHome(config, around);
    if (pathKey(home) !== pathKey(real(around))) {
      const found = twin(home, real(around));
      if (found) return found;
    }
  }
  return direct;
}

// The value of NAME in a dotenv file: `NAME=value`, `export NAME=value`, quoted or not, with a
// trailing ` # comment` dropped from an unquoted value.
export function readDotenv(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const raw = m[2].trim();
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
    const value = (quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')).trim();
    if (value) return value;
  }
  return null;
}

// Where the key for `repo` comes from, and the key itself (never printed by callers).
export function keyFor(config, repo, env = process.env) {
  const entry = entryFor(config, repo);
  if (!entry) return { problem: `no entry in ${config.file} covers ${repo}` };
  // Trimmed where it is read: a stray "\r" from a Windows file would make a refused key, and a
  // server that trims what it gets and echoes it would slip past the scrub.
  const fromEnv = env[entry.env]?.trim();
  if (fromEnv) return { entry, key: fromEnv, where: `${entry.env} in the environment` };
  if (entry.file) {
    let text;
    try {
      text = fs.readFileSync(entry.file, 'utf8');
    } catch (error) {
      return { entry, problem: `${entry.env} is not in the environment, and ${entry.file} cannot be read (${error.code ?? error.message})` };
    }
    const key = readDotenv(text, entry.env);
    if (key) return { entry, key, where: `${entry.env} in ${entry.file}` };
    return { entry, problem: `${entry.env} is not in the environment or in ${entry.file}` };
  }
  return { entry, problem: `${entry.env} is not in the environment` };
}

// Whether the judge is on for `repo`: { on, key?, why, model, url }.
export function judgeFor(repo, env = process.env) {
  const config = loadConfig(env);
  if (!config) return { on: false, why: `not set up (no ${configPath(env)})` };
  if (config.problem) return { on: false, why: config.problem };
  if (config.off) return { on: false, why: `switched off in ${config.file}` };
  // A typo, a removed checkout or a file: git cannot place it, and its path alone could name
  // another account's folder.
  if (!isDirectory(repo)) return { on: false, why: `${repo} is not a folder` };
  const found = keyFor(config, repoHome(config, repo), env);
  if (!found.key) return { on: false, why: found.problem };
  return { on: true, key: found.key, why: `key from ${found.where}`, model: config.model ?? DEFAULT_MODEL, url: config.url ?? JEV_URL };
}

const text = (value) => (value === undefined || value === null ? undefined : redact(String(value)));

// The state Jev reads for one question. For harm it gets only the scenario, so its pick does not
// just repeat the review's label.
export function stateFor(kind, finding) {
  const who = WHO[finding.who];
  if (kind === 'harm') return { finding: { scenario: text(finding.scenario) } };
  if (kind === 'priority') {
    return { finding: { scenario: text(finding.scenario), worst_case: finding.worst_case === 'small' ? SMALL : FIX_NOW[finding.worst_case], who_meets_it: who } };
  }
  return { finding: { scenario: text(finding.scenario), the_fix: text(finding.fix) } };
}

export function requestBody(kind, finding, model = DEFAULT_MODEL) {
  const q = QUESTIONS[kind];
  return { state: stateFor(kind, finding), model, questions: { [kind]: { type: 'choice', instructions: q.instructions, criteria: q.criteria } } };
}

// A problem with the finding itself that means no request is sent.
function skipReason(kind, finding) {
  const fields = kind === 'proof' ? ['scenario', 'fix'] : ['scenario'];
  for (const field of fields) {
    if (typeof finding[field] !== 'string' || !finding[field].trim()) return `no "${field}" to judge`;
    if (finding[field].length > MAX_FIELD_CHARS) return `"${field}" is longer than ${MAX_FIELD_CHARS} characters`;
  }
  if (kind === 'priority' && !Object.hasOwn(WHO, finding.who)) return `"who" must be one of ${Object.keys(WHO).join(', ')}`;
  if (kind === 'priority' && !WORST_CASES.includes(finding.worst_case)) return `"worst_case" must be one of ${WORST_CASES.join(', ')}`;
  return null;
}

// The answer to our one question, or a reason it cannot be used.
function readAnswer(kind, response) {
  const answer = response?.answers?.[kind];
  const options = Object.keys(QUESTIONS[kind].criteria);
  if (!answer || answer.type !== 'choice') return { problem: 'the answer has no choice for the question' };
  if (!options.includes(answer.choice)) return { problem: 'the answer picked something that is not an option' };
  if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) return { problem: 'the answer has no confidence' };
  // The model id is the one piece of the server's text that is printed, and only in its usual
  // shape (letters, digits, dots, dashes): nothing escaped can hide in it.
  const model = typeof response.model === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(response.model) ? response.model : null;
  return { choice: answer.choice, confidence: answer.confidence, model };
}

const named = (finding) => Object.hasOwn(FIX_NOW, finding.worst_case);
// A finding the rules settle without asking: real harm the review named is fixed now (or, on
// the list, recommended for fixing now), and a fix that is real harm, or has no worst case,
// gets the full proof.
const settled = (kind, finding) => named(finding) || (kind === 'proof' && finding.worst_case !== 'small');

// What the agent does with a finding, from the review's label and Jev's answer (or its failure).
export function decide(kind, finding, answer) {
  const out = (verdict, why) => ({ id: finding.id, kind, verdict, used: Boolean(answer?.choice), choice: answer?.choice ?? null, confidence: answer?.confidence ?? null, model: answer?.model ?? null, why });
  const sure = answer?.choice && answer.confidence >= FLOORS[kind];
  if (settled(kind, finding)) {
    if (kind === 'proof') return out('rule', named(finding) ? 'a real-harm fix gets the full proof' : 'no worst case given, so the full proof');
    return out('fix now', `the review named "${finding.worst_case}"`);
  }
  if (kind === 'harm') {
    if (!answer?.choice) return out('rule', `Jev not used: ${answer?.problem ?? 'no answer'}`);
    const pick = `${answer.choice}, confidence ${answer.confidence}`;
    if (answer.choice !== 'small' && sure) return out('fix now', `Jev: ${pick}`);
    if (answer.choice === 'small' && sure && finding.worst_case === 'small') return out('list', `the review and Jev: small (confidence ${answer.confidence})`);
    if (answer.choice === 'small' && sure) return out('rule', 'the review named no worst case, and Jev cannot clear it alone');
    return out('rule', `Jev unsure (${pick})`);
  }
  if (!answer?.choice) return out('rule', `Jev not used: ${answer?.problem ?? 'no answer'}`);
  if (!sure) return out('rule', `Jev unsure (${answer.choice}, confidence ${answer.confidence})`);
  if (kind === 'priority') return out(answer.choice === 'fix_now' ? 'fix now' : 'leave listed', `Jev: ${answer.choice} (confidence ${answer.confidence})`);
  return out(answer.choice, `Jev: ${answer.choice} (confidence ${answer.confidence})`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One try: the whole exchange, body included, inside one deadline. https goes through Node's
// shared agent, so a proxy set in the environment is used where Node supports that. A redirect
// is never followed (it would send the findings to
// a host the user never configured). Resolves to { status, retryAfter, raw } or { fail }.
function once(url, data, key, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(url);
    let req = null;
    let timer = null;
    const finish = (result) => {
      if (timer === 'done') return;
      clearTimeout(timer);
      timer = 'done';
      req?.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish({ fail: 'timeout' }), timeoutMs);
    try {
      req = (target.protocol === 'https:' ? https : http).request(target, {
        method: 'POST',
        // Plain http is only ever this machine (a test server): never through a proxy, which
        // would see the key unencrypted.
        ...(target.protocol === 'http:' ? { agent: false } : {}),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'first-pass-jev', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => finish({ status: res.statusCode, retryAfter: res.headers['retry-after'], raw: Buffer.concat(chunks).toString('utf8') }));
        res.on('close', () => { if (!res.complete) finish({ fail: 'cut off' }); });
      });
    } catch (error) {
      // Node refuses a header value holding a control character before anything is sent.
      finish({ fail: error.code === 'ERR_INVALID_CHAR' ? 'bad key' : 'network', code: error.code ?? error.name });
      return;
    }
    req.on('error', (error) => finish(req.res ? { fail: 'cut off' } : { fail: 'network', code: error.code ?? error.name }));
    req.end(data);
  });
}

// One request: a deadline on each try, and at most two retries, only for "slow down" answers and
// network errors (a judgment has no side effect, so a retry is safe). Never throws. No text the
// server supplies is printed (only status and error codes): an echoed key can come back in any
// encoding, so scrubbing what is printed cannot be relied on. The one exception, the model id, is
// checked for its shape in `readAnswer` and scrubbed here.
export async function post(body, { key, url = JEV_URL, timeoutMs = TIMEOUT_MS, backoffMs = 1000, stopAt = Infinity } = {}) {
  const scrub = (s) => String(s).split(key).join('[key]');
  const data = JSON.stringify(body);
  const spent = { problem: "the run's time budget ran out" };
  for (let attempt = 0; ; attempt++) {
    const limit = Math.min(timeoutMs, stopAt - Date.now());
    if (limit <= 0) return spent;
    const response = await once(url, data, key, limit);
    if (response.fail === 'timeout') return limit < timeoutMs ? spent : { problem: `no answer within ${timeoutMs / 1000} s` };
    if (response.fail === 'bad key') return { problem: 'the key holds a character a request header cannot carry: set it again' };
    if (response.fail === 'cut off') return { problem: 'the answer was cut off' };
    if (response.fail) {
      if (attempt < 2) { await wait(backoffMs * 2 ** attempt); continue; }
      return { problem: `cannot reach ${url} (${response.code})` };
    }
    if (RETRY_STATUSES.has(response.status) && attempt < 2) {
      const after = Number(response.retryAfter);
      await wait(Number.isFinite(after) && after > 0 && after <= 5 ? after * 1000 : backoffMs * 2 ** attempt);
      continue;
    }
    const raw = response.raw;
    if (response.status >= 300 && response.status < 400) return { problem: `${url} answered with a redirect, which is not followed` };
    if (response.status === 401) return { problem: 'the key was refused (401)' };
    if (response.status < 200 || response.status >= 300) return { problem: `HTTP ${response.status}${HINTS[response.status] ? `: ${HINTS[response.status]}` : ''}` };
    try {
      // Every string is scrubbed after it is decoded, so a key echoed in the answer, escaped or
      // not, is never printed.
      return { response: JSON.parse(raw, (name, value) => (typeof value === 'string' ? scrub(value) : value)) };
    } catch {
      return { problem: 'the answer is not JSON' };
    }
  }
}

// Judges every finding: a verdict for each, in order. Findings the rules settle, or that cannot
// be sent, get no request.
export async function judge(kind, findings, judgeOptions) {
  const results = new Array(findings.length);
  const stopAt = Date.now() + (judgeOptions.budgetMs ?? BUDGET_MS);
  let next = 0;
  async function worker() {
    while (next < findings.length) {
      const i = next++;
      const finding = findings[i];
      const skip = skipReason(kind, finding);
      if (settled(kind, finding)) results[i] = decide(kind, finding, null);
      else if (skip) results[i] = decide(kind, finding, { problem: skip });
      else if (!judgeOptions.on) results[i] = decide(kind, finding, { problem: judgeOptions.why });
      else {
        const sent = await post(requestBody(kind, finding, judgeOptions.model), { ...judgeOptions, stopAt });
        results[i] = decide(kind, finding, sent.problem ? { problem: sent.problem } : readAnswer(kind, sent.response));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, findings.length) }, worker));
  return results;
}

// The findings file the agent writes: a list of { id, scenario, worst_case?, who?, fix? }.
export function readFindings(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} cannot be read as JSON: ${error.message}`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error(`${file} must hold a list of findings`);
  if (list.length > MAX_FINDINGS) throw new Error(`${file} holds ${list.length} findings; send at most ${MAX_FINDINGS} at a time`);
  for (const [i, f] of list.entries()) {
    if (!f || typeof f !== 'object' || (typeof f.id !== 'string' && typeof f.id !== 'number')) throw new Error(`finding ${i} needs an "id"`);
    if (f.worst_case !== undefined && !WORST_CASES.includes(f.worst_case)) throw new Error(`finding ${f.id}: "worst_case" must be one of ${WORST_CASES.join(', ')}`);
  }
  return list;
}
