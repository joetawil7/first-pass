// The Jev judge, against a fake Jev server on this machine: the policy (Jev can add harm, never
// clear it; failures and unsure answers leave it to the rules), the request it sends, keys and
// config, and the CLI.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FIX_NOW, JEV_URL, configPath, decide, entryFor, judge, judgeFor, keyFor, loadConfig, readDotenv, readFindings, requestBody } from '../scripts/lib/jev.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs');
const KEY = 'ts-test-key-5f3a9c1e7b2d';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-pass-jev-'));
}
function configDir(config) {
  const dir = tempDir();
  if (config) {
    fs.mkdirSync(path.join(dir, 'first-pass'));
    fs.writeFileSync(path.join(dir, 'first-pass', 'jev.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

// A fake Jev: answers each request with reply(body, n), records every request.
async function fakeJev(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, agent: req.headers['user-agent'], body });
      const out = reply(body, requests.length, req);
      if (out === 'hang') return;
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  return { url, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
const answer = (kind, choice, confidence) => ({ body: { model: 'jev-1.13.0', answers: { [kind]: { type: 'choice', choice, confidence, probabilities: {} } }, usage: { input_tokens: 300 } } });
const on = (server, extra = {}) => ({ on: true, key: KEY, model: 'jev-latest', url: server.url, backoffMs: 0, ...extra });
const small = (scenario = 'The page says "Saved" for a moment after a failed save, then shows the error.') => ({ id: 'F1', scenario, worst_case: 'small', who: 'unusual' });

test('real harm the review named is fixed now without asking Jev', async () => {
  const server = await fakeJev(() => answer('harm', 'small', 0.99));
  try {
    for (const kind of Object.keys(FIX_NOW)) {
      const [r] = await judge('harm', [{ id: 'F', scenario: 'x', worst_case: kind }], on(server));
      assert.equal(r.verdict, 'fix now', kind);
      assert.equal(r.used, false);
    }
    const [proof] = await judge('proof', [{ id: 'F', scenario: 'x', fix: 'one line', worst_case: 'money' }], on(server));
    assert.equal(proof.verdict, 'rule', 'a real-harm fix never gets a lighter proof');
    assert.equal(server.requests.length, 0, 'no request was sent');
  } finally {
    await server.close();
  }
});

test('Jev can make a small finding real harm when sure; an unsure answer either way leaves it to the rules', async () => {
  for (const [choice, confidence, verdict] of [['twice', 0.8, 'fix now'], ['twice', 0.3, 'rule'], ['small', 0.9, 'list'], ['small', 0.3, 'rule'], ['data', 0.5, 'fix now']]) {
    const server = await fakeJev(() => answer('harm', choice, confidence));
    try {
      const [r] = await judge('harm', [small()], on(server));
      assert.equal(r.verdict, verdict, `${choice} at ${confidence}`);
      assert.equal(r.used, true);
    } finally {
      await server.close();
    }
  }
});

test('a real harm on the list is always recommended "fix now", and a fix with no worst case gets the full proof', async () => {
  const server = await fakeJev((body) => answer(Object.keys(body.questions)[0], Object.keys(body.questions)[0] === 'priority' ? 'leave_listed' : 'checks', 0.99));
  try {
    for (const kind of Object.keys(FIX_NOW)) {
      const [r] = await judge('priority', [{ id: 'F', scenario: 'An older retry charges twice.', worst_case: kind, who: 'unusual' }], on(server));
      assert.equal(r.verdict, 'fix now', kind);
    }
    const [proof] = await judge('proof', [{ id: 'F', scenario: 'x', fix: 'one line' }], on(server));
    assert.equal(proof.verdict, 'rule');
    assert.equal(server.requests.length, 0, 'neither was sent');
  } finally {
    await server.close();
  }
});

test('Jev alone never clears a finding the review gave no worst case', async () => {
  const server = await fakeJev(() => answer('harm', 'small', 0.99));
  try {
    const [r] = await judge('harm', [{ id: 'F', scenario: 'A post can go out twice after a retry.' }], on(server));
    assert.equal(r.verdict, 'rule');
  } finally {
    await server.close();
  }
});

test('a failure or an answer that cannot be used leaves the decision to the rules, never to the lighter side', async () => {
  const cases = [
    () => ({ status: 500, body: { error: 'boom' } }),
    () => ({ status: 422, body: { detail: 'bad' } }),
    () => ({ body: 'not json' }),
    () => ({ body: { answers: {} } }),
    () => answer('harm', 'maybe', 0.9),
    () => ({ body: { answers: { harm: { type: 'choice', choice: 'small' } } } }),
  ];
  for (const reply of cases) {
    const server = await fakeJev(reply);
    try {
      const [harm] = await judge('harm', [small()], on(server));
      assert.equal(harm.verdict, 'rule', JSON.stringify(reply()));
      assert.equal(harm.used, false);
      const [proof] = await judge('proof', [{ ...small(), fix: 'one line' }], on(server));
      assert.equal(proof.verdict, 'rule');
    } finally {
      await server.close();
    }
  }
});

test('a refused key is reported without the key, and is not retried', async () => {
  const server = await fakeJev(() => ({ status: 401, body: { detail: `bad key ${KEY}` } }));
  try {
    const [r] = await judge('harm', [small()], on(server));
    assert.equal(r.verdict, 'rule');
    assert.match(r.why, /refused/);
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('no text the server sends is printed: an error shows its status, a bad pick is not quoted', async () => {
  const server = await fakeJev((body, n) => (n === 1 ? { status: 500, body: `upstream said ${KEY}` } : answer('harm', 'maybe-this-one', 0.9)));
  try {
    const [error] = await judge('harm', [small()], on(server));
    assert.equal(error.why, 'Jev not used: HTTP 500');
    const [pick] = await judge('harm', [small()], on(server));
    assert.equal(pick.verdict, 'rule');
    assert.doesNotMatch(pick.why, /maybe-this-one/);
  } finally {
    await server.close();
  }
});

// A server that sends its headers and part of a body holding the key, then stalls or drops.
async function halfAnswer(then) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write(`{"model":"${KEY}","answers":`);
      if (then === 'drop') setTimeout(() => res.socket.destroy(), 50);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('an answer that stalls after it starts is given up on at the deadline', { timeout: 5000 }, async () => {
  const server = await halfAnswer('stall');
  try {
    const started = Date.now();
    const [r] = await judge('harm', [small()], on(server, { timeoutMs: 500 }));
    assert.ok(Date.now() - started < 2500, `gave up after ${Date.now() - started} ms`);
    assert.equal(r.why, 'Jev not used: no answer within 0.5 s');
  } finally {
    await server.close();
  }
});

test('the guards against printing: a dropped answer, a key a header cannot carry, a model id that is not an id', { timeout: 10000 }, async () => {
  const dropped = await halfAnswer('drop');
  try {
    const [r] = await judge('harm', [small()], on(dropped));
    assert.equal(r.why, 'Jev not used: the answer was cut off');
  } finally {
    await dropped.close();
  }
  const server = await fakeJev(() => ({ body: { model: `${KEY.slice(0, 4)} ${KEY.slice(4)}`, answers: { harm: { type: 'choice', choice: 'small', confidence: 0.9 } } } }));
  try {
    const [bad] = await judge('harm', [small()], on(server, { key: `${KEY}\nx` }));
    assert.equal(bad.why, 'Jev not used: the key holds a character a request header cannot carry: set it again');
    assert.equal(server.requests.length, 0, 'nothing is sent with a broken key');
    const [split] = await judge('harm', [small()], on(server));
    assert.equal(split.model, null, 'a model id with a space is not an id, so it is not printed');
    assert.ok(!JSON.stringify(split).includes(KEY.slice(4)));
  } finally {
    await server.close();
  }
});

test('a key holding a quote, a backslash or a tab is not printed when a JSON error echoes it', async () => {
  // Echoes the bearer value inside JSON, which writes it escaped (\" \\ \t).
  const server = await fakeJev((body, n, req) => ({ status: 400, body: { error: `malformed header: ${req.headers.authorization}` } }));
  try {
    for (const key of [`"${KEY}"`, `${KEY}\\x`, `${KEY.slice(0, 4)}\t${KEY.slice(4)}`]) {
      const [r] = await judge('harm', [small()], on(server, { key }));
      const out = JSON.stringify(r);
      assert.ok(!out.includes(KEY.slice(4)) && !out.includes(KEY.slice(1, 12)), out);
    }
  } finally {
    await server.close();
  }
});

test('no piece of the key is printed when an error body echoes it past the cut', async () => {
  const server = await fakeJev(() => ({ status: 500, body: `${'e'.repeat(190)}${KEY}` }));
  try {
    const [r] = await judge('harm', [small()], on(server));
    assert.ok(!JSON.stringify(r).includes(KEY.slice(0, 8)), r.why);
  } finally {
    await server.close();
  }
});

test('a key the server echoes back in its answer is never printed', async () => {
  for (const where of ['choice', 'model']) {
    const server = await fakeJev(() => ({ body: { model: where === 'model' ? KEY : 'jev-1.13.0', answers: { harm: { type: 'choice', choice: where === 'choice' ? KEY : 'small', confidence: 0.9 } } } }));
    try {
      const [r] = await judge('harm', [small()], on(server));
      assert.ok(!JSON.stringify(r).includes(KEY), where);
    } finally {
      await server.close();
    }
  }
});

test('a key echoed back with JSON escapes, in an answer or an error, or as a name, is never printed', async () => {
  const escaped = `\\u00${KEY.charCodeAt(0).toString(16)}${KEY.slice(1)}`;
  const bodies = [
    { body: `{"model":"jev-1.13.0","answers":{"harm":{"type":"choice","choice":"${escaped}","confidence":0.9}}}` },
    { status: 500, body: `{"detail":"bad key ${escaped}"}` },
    { body: { model: { [KEY]: 1 }, answers: { harm: { type: 'choice', choice: 'small', confidence: 0.9 } } } },
    { status: 502, body: `<html>upstream said {"detail":"${escaped}"} and more</html>` },
  ];
  for (const reply of bodies) {
    const server = await fakeJev(() => reply);
    try {
      const [r] = await judge('harm', [small()], on(server));
      // Neither the key nor what follows a leading escape (\u0074, then the rest) is printed.
      assert.ok(!JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes(KEY.slice(1)), JSON.stringify(r));
    } finally {
      await server.close();
    }
  }
});

test('a folder the config names keeps its own key; its main checkout is used only when the folder itself is not named', async () => {
  const run = promisify(execFile);
  const makeRepo = (name) => {
    const dir = path.join(tempDir(), name);
    fs.mkdirSync(dir);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    return dir;
  };
  const a = makeRepo('company-a'), b = makeRepo('company-b');
  const worktree = path.join(tempDir(), 'a-worktree');
  execFileSync('git', ['-C', a, 'worktree', 'add', '-q', '--detach', worktree]);
  const link = path.join(tempDir(), 'link-to-a');
  fs.symlinkSync(a, link, process.platform === 'win32' ? 'junction' : 'dir');
  const findings = path.join(tempDir(), 'f.json');
  fs.writeFileSync(findings, JSON.stringify([small()]));
  const server = await fakeJev(() => answer('harm', 'small', 0.9));
  const ask = (keys, where, extra = {}) => run(process.execPath, [CLI, 'jev', 'ask', 'harm', findings, where], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir({ url: server.url, keys }), FP_A: 'key-of-a', FP_B: 'key-of-b', FP_C: 'key-of-c', FP_D: 'key-of-d', ...extra } });
  try {
    await ask([{ env: 'FP_C', repos: [worktree] }, { env: 'FP_D', repos: [b] }], worktree);
    await ask([{ env: 'FP_A', repos: [link] }, { env: 'FP_D', repos: [b] }], a);
    // A GIT_DIR left in the environment must not make git answer for another repo.
    await ask([{ env: 'FP_A', repos: [a] }, { env: 'FP_B', repos: [b] }], worktree, { GIT_DIR: path.join(b, '.git') });
    // A folder inside a repo that is not a repo itself, named on its own, keeps its own key.
    const plain = path.join(a, 'docs');
    fs.mkdirSync(plain);
    await ask([{ env: 'FP_A', repos: [a] }, { env: 'FP_C', repos: [plain] }], plain);
    // A worktree beside its repo, inside a parent folder named for another account, gets its
    // repo's key: the parent's entry is for folders of the parent's own, not other repos' checkouts.
    const parent = tempDir();
    const inner = path.join(parent, 'company-y');
    fs.mkdirSync(inner);
    execFileSync('git', ['-C', inner, 'init', '-q']);
    execFileSync('git', ['-C', inner, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    const beside = path.join(parent, 'company-y-wt');
    execFileSync('git', ['-C', inner, 'worktree', 'add', '-q', '--detach', beside]);
    await ask([{ env: 'FP_B', repos: [parent] }, { env: 'FP_A', repos: [inner] }], beside);
    assert.deepEqual(server.requests.map((r) => r.auth), ['Bearer key-of-c', 'Bearer key-of-a', 'Bearer key-of-a', 'Bearer key-of-c', 'Bearer key-of-a']);
  } finally {
    await server.close();
  }
});

test('a key stored with stray whitespace is sent trimmed and never printed when echoed', async () => {
  const run = promisify(execFile);
  // Echoes the bearer value it received, as a model name and in an error body.
  const server = await fakeJev((body, n, req) => {
    const got = req.headers.authorization.slice(7);
    return n === 1 ? { body: { model: got, answers: { harm: { type: 'choice', choice: 'small', confidence: 0.9 } } } } : { status: 403, body: { detail: got } };
  });
  try {
    const repo = tempDir();
    const findings = path.join(tempDir(), 'f.json');
    fs.writeFileSync(findings, JSON.stringify([small()]));
    for (const stored of [`${KEY}\r`, ` ${KEY}\t`]) {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir({ url: server.url, keys: [{ env: 'FP_TEST_JEV_KEY', repos: [repo] }] }), FP_TEST_JEV_KEY: stored };
      server.requests.length = 0;
      const probe = await run(process.execPath, [CLI, 'jev', 'test', repo], { env });
      const ask = await run(process.execPath, [CLI, 'jev', 'ask', 'harm', findings, repo], { env });
      for (const out of [probe, ask]) assert.ok(!(out.stdout + out.stderr).includes(KEY), JSON.stringify(stored));
      assert.equal(server.requests[0].auth, `Bearer ${KEY}`);
    }
  } finally {
    await server.close();
  }
});

test('with separate accounts there is no default key: a folder no entry names has the judge off', async () => {
  const a = tempDir();
  const mixed = { CLAUDE_CONFIG_DIR: configDir({ keys: [{ env: 'K1', repos: [a] }, { env: 'K2' }] }), K1: 'x', K2: 'y' };
  assert.match(loadConfig(mixed).problem, /only entry/);
  assert.equal(judgeFor(a, mixed).on, false);
  const named = { CLAUDE_CONFIG_DIR: configDir({ keys: [{ env: 'K1', repos: [a] }] }), K1: 'x' };
  assert.equal(judgeFor(a, named).on, true);
  assert.match(judgeFor(tempDir(), named).why, /no entry/);
  const [r] = await judge('harm', [small()], judgeFor(tempDir(), named));
  assert.equal(r.verdict, 'rule');
});

test('a worktree or a linked folder gets its repo\'s key', async () => {
  const run = promisify(execFile);
  const repo = path.join(tempDir(), 'company-a');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const worktree = path.join(tempDir(), 'company-a-check');
  git('worktree', 'add', '-q', '--detach', worktree);
  const link = path.join(tempDir(), 'link-to-a');
  fs.symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
  const server = await fakeJev(() => answer('harm', 'small', 0.9));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir({ url: server.url, keys: [{ env: 'FP_A', repos: [repo] }, { env: 'FP_B', repos: [tempDir()] }] }), FP_A: 'key-of-a', FP_B: 'key-of-b' };
    const findings = path.join(tempDir(), 'f.json');
    fs.writeFileSync(findings, JSON.stringify([small()]));
    for (const where of [repo, path.join(worktree), link]) await run(process.execPath, [CLI, 'jev', 'ask', 'harm', findings, where], { env });
    assert.deepEqual(server.requests.map((r) => r.auth), ['Bearer key-of-a', 'Bearer key-of-a', 'Bearer key-of-a']);
  } finally {
    await server.close();
  }
});

test('a redirect is refused: nothing reaches a host the user did not configure', async () => {
  const other = await fakeJev(() => answer('harm', 'small', 0.9));
  const server = http.createServer((req, res) => { res.writeHead(307, { location: other.url }); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const [r] = await judge('harm', [small()], on({ url: `http://127.0.0.1:${server.address().port}/v1/systemone` }));
    assert.equal(r.verdict, 'rule');
    assert.match(r.why, /redirect/);
    assert.equal(other.requests.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await other.close();
  }
});

test('a server that never answers is given up on at the deadline', { timeout: 5000 }, async () => {
  const server = await fakeJev(() => 'hang');
  try {
    const started = Date.now();
    const [r] = await judge('harm', [small()], on(server, { timeoutMs: 300 }));
    assert.equal(r.verdict, 'rule');
    assert.match(r.why, /no answer within/);
    assert.ok(Date.now() - started < 3000);
    assert.equal(server.requests.length, 1, 'a timeout is not retried');
  } finally {
    await server.close();
  }
});

test('"slow down" answers are retried at most twice', async () => {
  const later = await fakeJev((body, n) => (n === 1 ? { status: 429, body: {} } : answer('harm', 'small', 0.9)));
  try {
    const [r] = await judge('harm', [small()], on(later));
    assert.equal(r.verdict, 'list');
    assert.equal(later.requests.length, 2);
  } finally {
    await later.close();
  }
  const never = await fakeJev(() => ({ status: 529, body: {} }));
  try {
    const [r] = await judge('harm', [small()], on(never));
    assert.equal(r.verdict, 'rule');
    assert.equal(never.requests.length, 3);
  } finally {
    await never.close();
  }
});

test('the request: the endpoint shape, the key as a bearer token, one choice question, and only the scenario for harm', async () => {
  const server = await fakeJev(() => answer('harm', 'small', 0.9));
  try {
    await judge('harm', [small('Charged twice? No: the label says "Paid" before the webhook lands.')], on(server));
    const [req] = server.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.auth, `Bearer ${KEY}`);
    assert.equal(req.body.model, 'jev-latest');
    assert.ok(req.agent, 'the request names itself (some firewalls refuse one that does not)');
    assert.equal(req.body.questions.harm.type, 'choice');
    assert.deepEqual(Object.keys(req.body.questions.harm.criteria).sort(), [...Object.keys(FIX_NOW), 'small'].sort());
    assert.deepEqual(Object.keys(req.body.state.finding), ['scenario'], 'harm is judged from the scenario alone, not the review label');
  } finally {
    await server.close();
  }
  assert.equal(JEV_URL, 'https://api.typesafe.ai/v1/systemone');
});

test('secrets, emails and phone numbers are blanked before anything is sent', () => {
  // A made-up key in a secret's shape, written so no scanner reads the source as a real one.
  const fake = ['sk', 'test', 'FAKE0000example0000key'].join('_');
  const body = requestBody('proof', { id: 'F', scenario: `The key ${fake} is logged for ana@example.com, +971 50 123 4567.`, fix: 'drop the log line' });
  const sent = JSON.stringify(body);
  assert.ok(!sent.includes(fake));
  assert.doesNotMatch(sent, /ana@example\.com|123 4567/);
  assert.match(sent, /\[secret\]/);
  assert.match(sent, /\[email\]/);
});

test('a finding too long or missing what the question needs is not sent', async () => {
  const server = await fakeJev(() => answer('harm', 'small', 0.9));
  try {
    const results = await judge('harm', [{ id: 'long', scenario: 'x'.repeat(8001), worst_case: 'small' }, { id: 'none', worst_case: 'small' }], on(server));
    assert.deepEqual(results.map((r) => r.verdict), ['rule', 'rule']);
    const [p] = await judge('priority', [{ id: 'p', scenario: 'x', worst_case: 'small' }], on(server));
    assert.equal(p.verdict, 'rule', 'priority needs who meets it');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('priority and proof picks count only above their floors', async () => {
  const checks = [['priority', 'fix_now', 0.7, 'fix now'], ['priority', 'leave_listed', 0.9, 'leave listed'], ['priority', 'fix_now', 0.5, 'rule'], ['proof', 'unit', 0.8, 'unit'], ['proof', 'checks', 0.6, 'rule']];
  for (const [kind, choice, confidence, verdict] of checks) {
    const server = await fakeJev(() => answer(kind, choice, confidence));
    try {
      const [r] = await judge(kind, [{ ...small(), fix: 'change the label' }], on(server));
      assert.equal(r.verdict, verdict, `${kind} ${choice} ${confidence}`);
    } finally {
      await server.close();
    }
  }
});

test('with the judge off, every finding gets "rule" and nothing is sent', async () => {
  const results = await judge('harm', [small(), { id: 'F2', scenario: 'x', worst_case: 'money' }], { on: false, why: 'not set up' });
  assert.deepEqual(results.map((r) => r.verdict), ['rule', 'fix now']);
  assert.match(results[0].why, /not set up/);
});

test('decide never returns "list" for a finding the review named as harm', () => {
  for (const kind of Object.keys(FIX_NOW)) {
    assert.equal(decide('harm', { id: 1, worst_case: kind }, { choice: 'small', confidence: 1 }).verdict, 'fix now');
  }
});

test('config: missing is off, a broken one says why, and the url must be https or this machine', () => {
  assert.equal(loadConfig({ CLAUDE_CONFIG_DIR: configDir() }), null);
  assert.match(loadConfig({ CLAUDE_CONFIG_DIR: configDir('{') }).problem, /cannot be read as JSON/);
  assert.match(loadConfig({ CLAUDE_CONFIG_DIR: configDir({ keys: [{}] }) }).problem, /needs "env"/);
  assert.match(loadConfig({ CLAUDE_CONFIG_DIR: configDir({ keys: [{ env: 'K', repos: ['relative'] }] }) }).problem, /absolute/);
  assert.match(loadConfig({ CLAUDE_CONFIG_DIR: configDir({ url: 'http://example.com/v1', keys: [] }) }).problem, /https/);
  assert.equal(loadConfig({ CLAUDE_CONFIG_DIR: configDir({ url: 'http://127.0.0.1:9/v1', keys: [] }) }).problem, undefined);
  const env = { CLAUDE_CONFIG_DIR: configDir({ off: true, keys: [{ env: 'K' }] }), K: 'x' };
  assert.match(judgeFor(tempDir(), env).why, /switched off/);
  assert.match(judgeFor(tempDir(), { CLAUDE_CONFIG_DIR: configDir() }).why, /not set up/);
  assert.equal(configPath({ CLAUDE_CONFIG_DIR: 'C' }), path.join('C', 'first-pass', 'jev.json'));
});

test('keys: each repo gets its own account\'s key, from the environment or a dotenv file', () => {
  const a = path.join(tempDir(), 'company-a'), b = path.join(a, 'nested'), c = path.join(tempDir(), 'company-c');
  const envFile = path.join(tempDir(), '.env.local');
  fs.writeFileSync(envFile, '# keys\r\nOTHER=1\r\nexport C_KEY="from-file"  \r\n');
  const config = { file: 'jev.json', keys: [{ env: 'A_KEY', repos: [a] }, { env: 'B_KEY', repos: [b] }, { env: 'C_KEY', file: envFile, repos: [c] }] };
  const env = { A_KEY: 'a', B_KEY: 'b' };
  assert.equal(keyFor(config, path.join(a, 'src'), env).key, 'a');
  assert.equal(keyFor(config, path.join(b, 'src'), env).key, 'b', 'the deepest repo wins');
  assert.equal(keyFor(config, c, env).key, 'from-file');
  assert.match(keyFor(config, c, env).where, /\.env\.local/);
  assert.match(keyFor(config, tempDir(), env).problem, /no entry/);
  assert.equal(entryFor({ keys: [{ env: 'D' }] }, tempDir()).env, 'D', 'a lone entry with no repos covers every folder');
  assert.equal(entryFor({ keys: [{ env: 'A_KEY', repos: [a] }] }, tempDir()), null, 'a folder no entry names has no key');
  assert.match(keyFor({ file: 'f', keys: [{ env: 'NOPE', file: envFile }] }, a, {}).problem, /not in the environment or in/);
  if (process.platform === 'win32') assert.equal(keyFor(config, a.toUpperCase(), env).key, 'a', 'Windows paths match in any case');
});

test('dotenv values: quoted, unquoted with a comment, export, and a missing name', () => {
  assert.equal(readDotenv("K='v 1'", 'K'), 'v 1');
  assert.equal(readDotenv('K=v2 # note', 'K'), 'v2');
  assert.equal(readDotenv('export K=v3', 'K'), 'v3');
  assert.equal(readDotenv('K=" v4 "', 'K'), 'v4', 'a quoted key is trimmed too');
  assert.equal(readDotenv('K="v5"  # the judge key', 'K'), 'v5', 'a quoted value followed by a comment loses its quotes');
  assert.equal(readDotenv('KK=x\nK=', 'K'), null);
});

test('the findings file is checked before anything is sent', () => {
  const dir = tempDir();
  const file = (name, value) => { const p = path.join(dir, name); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
  assert.throws(() => readFindings(file('a.json', '{')), /cannot be read/);
  assert.throws(() => readFindings(file('b.json', [])), /list of findings/);
  assert.throws(() => readFindings(file('c.json', [{ scenario: 'x' }])), /needs an "id"/);
  assert.throws(() => readFindings(file('d.json', [{ id: 1, worst_case: 'bad' }])), /worst_case/);
  assert.throws(() => readFindings(file('e.json', Array.from({ length: 51 }, (_, i) => ({ id: i })))), /at most 50/);
  assert.equal(readFindings(file('f.json', [{ id: 1, scenario: 'x', worst_case: 'small' }])).length, 1);
});

test('cli: status, ask and test against the fake server, and the key never printed', async () => {
  const run = promisify(execFile);
  const server = await fakeJev((body) => answer(Object.keys(body.questions)[0], 'small', 0.9));
  try {
    const repo = tempDir();
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir({ url: server.url, keys: [{ env: 'FP_TEST_JEV_KEY', repos: [repo] }] }), FP_TEST_JEV_KEY: KEY };
    const status = await run(process.execPath, [CLI, 'jev', 'status', repo], { env });
    assert.match(status.stdout, /on, key from FP_TEST_JEV_KEY in the environment/);
    assert.ok(status.stdout.includes(server.url), 'a url that is not TypeSafe\'s own is shown');
    // Without a repo, the default key could be another account's: ask and test refuse.
    for (const sub of [['ask', 'harm', path.join(tempDir(), 'none.json')], ['test']]) {
      await assert.rejects(run(process.execPath, [CLI, 'jev', ...sub], { env }), (error) => error.code === 2 && /needs the findings file and the repo|needs the repo whose key to try/.test(error.stderr), sub[0]);
    }
    const findings = path.join(tempDir(), 'f.json');
    fs.writeFileSync(findings, JSON.stringify([small(), { id: 'F2', scenario: 'x', worst_case: 'crash' }]));
    const ask = await run(process.execPath, [CLI, 'jev', 'ask', 'harm', findings, repo], { env });
    assert.deepEqual(JSON.parse(ask.stdout).map((r) => r.verdict), ['list', 'fix now']);
    const probe = await run(process.execPath, [CLI, 'jev', 'test', repo], { env });
    assert.match(probe.stdout, /answered "small"/);
    for (const out of [status, ask, probe]) assert.ok(!(out.stdout + out.stderr).includes(KEY));
    const off = await run(process.execPath, [CLI, 'jev', 'status', tempDir()], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir() } });
    assert.match(off.stdout, /off, not set up/);
    await assert.rejects(run(process.execPath, [CLI, 'jev', 'ask', 'mood', findings], { env }), (error) => error.code === 2 && /harm, priority or proof/.test(error.stderr));
    await assert.rejects(run(process.execPath, [CLI, 'jev', 'test', tempDir()], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir() } }), (error) => error.code === 2 && /is off/.test(error.stderr));
  } finally {
    await server.close();
  }
});
