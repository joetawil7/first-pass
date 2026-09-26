// What the user typed in their recent Claude Code sessions, for the habit-words skill.
// Kept: prompts the user typed, including ones queued while Claude was busy. Left out: tool
// output, pasted text, notifications, messages from other sessions, skill and system text,
// commands and their output, compaction summaries, and turns a script started (`claude -p`).
// Also kept: the end of the agent's reply before each prompt that may be pushing back.
// Anything that looks like a secret is replaced before the text goes anywhere.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathKey } from './paths.mjs';

export const WORDS_FILE = /^first-pass-words-[0-9a-f]{12}\.md$/;

// A prompt counts once per family. These are candidates for the skill to read, not verdicts:
// "make sure the tests pass" names a check, "be 100% sure" asks for a feeling.
export const FAMILIES = [
  { id: 'certainty', label: '"100% sure", "confident", "make sure", "guarantee"', re: /\b(100\s?%|a hundred percent|(be|make) (really |fully |totally |very )?sure|confident(ly)?|certain(ly)?|guarantee)/i },
  { id: 'assume', label: '"don\'t assume"', re: /\b(don'?t|do not|never|without|stop|no) assum/i },
  { id: 'all-cases', label: '"all gaps", "all cases", "edge cases"', re: /\ball (the )?(gaps|cases|edge cases|scenarios|possibilities)\b|\bevery (case|scenario|gap|edge case)\b|\bedge cases\b/i },
  { id: 'bug-free', label: '"bug free", "doesn\'t break anything"', re: /\bbug[- ]?free\b|\bno bugs\b|\b(doesn'?t|does not|won'?t|will not|without|not|never) break(ing|s)? anything\b/i },
  { id: 'full', label: '"full", "deep", "comprehensive", "everything"', re: /\b(full(y)?|deep(ly)?|comprehensive(ly)?|thorough(ly)?|in[- ]depth|every single|everything)\b/i },
  { id: 'quality', label: '"carefully", "correctly", "perfect", "high quality"', re: /\b(careful(ly)?|correctly|properly|perfect(ly)?|high[- ]quality|do it (right|correct(ly)?)|no rush|take your time)\b/i },
  { id: 'challenge', label: '"are you sure?"', re: /\bare you (really )?(sure|certain|confident)\b/i },
  { id: 'leading', label: '"all fine, right?", "is it done?", "anything left?"', re: /\bright\s*\?|\ball (fine|good|done|set)\b|\bis (it|that|everything|all) (done|fine|good|ok|okay|working)\b|\banything (else )?(left|missing|remaining)\b|\bnothing else\b/i },
  { id: 'forever', label: '"once and for all"', re: /\bonce and for all\b|\bfor good\b|\bpermanent(ly)? fix/i },
  { id: 'grant', label: '"do whatever you want", "take control"', re: /\bdo (whatever|what ever|anything) you (want|need|like|think)\b|\btake (full )?control\b|\byou decide\b|\bup to you\b|\bfull access\b/i },
  { id: 'frustration', label: 'frustration ("wtf", "!!")', re: /\b(wtf|what the (fuck|hell)|ffs|seriously)\b|!{2,}/i },
];

// A prompt that may be pushing back on the previous reply: the skill reads the reply and the
// prompt together to see what went wrong after a habit word.
const PUSHBACK = /\b(you said|you told me|you claimed|you promised|why (did|didn'?t|did not|are|were|would|is|was) (you|it|this|that)|still (not|broken|failing|wrong|the same|doesn'?t|isn'?t|don'?t|getting|happening|there)|(doesn'?t|does not|didn'?t|did not|isn'?t|is not) work(ing)?|not working|re-?read|re-?check|double[- ]check|are you (really )?(sure|certain)|(that'?s|this is|it'?s) (not (true|right|correct)|wrong)|incorrect|you (missed|forgot|ignored|skipped|broke)|i (told|asked) you|i said)\b/i;

// Kept whole-tag removals: none of these is something the user typed.
const DROP_TAGS = [
  'system-reminder', 'ide_selection', 'ide_opened_file', 'ide_diagnostics', 'local-command-caveat',
  'local-command-stdout', 'local-command-stderr', 'command-name', 'command-message', 'task-notification',
  'cross-session-message', 'bash-input', 'bash-stdout', 'bash-stderr', 'user-memory-input',
];

// Best effort: labelled values ("password: x", "App password for mail: x", "db_password: x",
// "the token is x1y2", "API_KEY=x"), the shapes vendors use, long opaque strings, and contact
// details. A label followed by ordinary words ("Key question: are you sure?") is left alone,
// so the habit words around it still count.
const VALUE = String.raw`("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)`;
const LABEL_WORDS = String.raw`(?:api[ _-]?key|access[ _-]?key|secret[ _-]?key|client[ _-]?secret|secret|token|password|passwd|pass|pwd|pw|passcode|bearer|authorization|credentials?|key|identifier|(?:client|tenant|app|application|account|project)[ _-]?id)`;
// A label, up to 40 characters of its own name ("Client Secret ID", "password for gmail"), then
// ":" or "=" (not "://"), then the value.
const LABEL_LINE = new RegExp(String.raw`(\b${LABEL_WORDS}\b[^:=\n]{0,40}?\s*[:=])(?!\/\/)[ \t]*(?=\S)([^\n]*)`, 'gi');
const LABEL = /\b(api[ _-]?key|access[ _-]?key|secret[ _-]?key|client[ _-]?secret|token|secret|password|passwd|pwd|pw|passcode|bearer|authorization)(\s+is)?(\s+)["']?([^\s"',;]{6,})/gi;
// An identifier (snake_case, kebab, dotted or camelCase) that names a secret, then ":" or "=".
const NAMED = new RegExp(String.raw`(["']?)\b([A-Za-z][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(?!\/\/)${VALUE}`, 'g');
const SECRET_NAME = /password|passwd|passphrase|pwd|secret|token|api[_.-]?key|access[_.-]?key|private[_.-]?key|credential|dsn|(^|[_.-])(pass|auth|key)([_.-]|$)|[a-z](Pass|Auth|Key)([A-Z]|$)/i;

// A value that reads like a credential, not like words: a digit, a symbol inside it, or a
// capital after the first letter.
export function looksSecret(token) {
  const t = token.replace(/[.,;:!?)\]]+$/, '');
  return t.length >= 6 && (/\d/.test(t) || /[^A-Za-z'-]/.test(t) || /.[A-Z]/.test(t));
}

function labelLine(match, label, value) {
  const first = value.split(/\s+/)[0];
  if (looksSecret(first)) return `${label} [secret]`;
  // A mail app password: four groups of four letters.
  const grouped = /^[a-z]{4}( [a-z]{4}){3}\b/.exec(value);
  return grouped ? `${label} [secret]${value.slice(grouped[0].length)}` : match;
}

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[secret]'],
  // The password may itself hold "@": everything up to the last "@" before the host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s/]+@/gi, '$1[secret]@'],
  [new RegExp(String.raw`\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PWD|DSN)[A-Z0-9_]*)(\([^)\n]*\))?\s*=\s*${VALUE}`, 'g'), '$1$2=[secret]'],
  [NAMED, (match, quote, name, sep) => {
    const identifier = /[_.-]/.test(name) || /[a-z][A-Z]/.test(name);
    return identifier && SECRET_NAME.test(name) ? `${quote}${name}${quote}${sep}[secret]` : match;
  }],
  [LABEL_LINE, labelLine],
  // After a bare space only a value that reads like a credential counts: "password reset" stays.
  [LABEL, (match, label, is = '', sep, value) => (looksSecret(value) ? `${label}${is}${sep}[secret]` : match)],
  [/\b(code|otp|pin|passcode)(\s+is)?(:?\s+)\d{6}\b/gi, '$1$2$3[secret]'],
  [/\bA{12,}[A-Za-z0-9%_+=~.-]*/g, '[secret]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[secret]'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '[secret]'],
  [/\b(whsec|re|xai|gsk|hf|npm|pypi|dop_v1)_[A-Za-z0-9]{16,}/g, '[secret]'],
  [/\bsk-(ant|proj)-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{16,}/g, '[secret]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[secret]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, '[secret]'],
  // Base64 with "/" in it, taken whole before the next rule splits it; a URL path has dots or
  // dashes, or lacks one of digits, lower and upper case.
  [/[A-Za-z0-9+/]{32,}={0,2}/g, (match) => (/\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match) ? '[secret]' : match)],
  // Hex, base64, URL-encoded and random ids: three digits or more, or 32+ characters mixing
  // digits and both cases. A hyphenated name with one digit ("ffmpeg7-linux-notes") stays.
  [/[A-Za-z0-9_+=%~-]{24,}/g, (match) => {
    const digits = (match.match(/\d/g) ?? []).length;
    return digits >= 3 || (match.length >= 32 && digits && /[a-z]/.test(match) && /[A-Z]/.test(match)) ? '[secret]' : match;
  }],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/\+\d[\d -]{7,16}\d\b|\b\d{10,15}\b|\(?\b\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g, '[number]'],
];

export function redact(text) {
  let out = text;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

export function projectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// Claude Code removes old transcripts on its own schedule: one gone between the listing and
// the read is skipped, not an error.
function gone(fn) {
  try {
    return fn();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Every session transcript, newest first. Subagent transcripts sit a level deeper and hold no
// words the user typed.
export function sessionFiles(dir) {
  const out = [];
  for (const project of gone(() => fs.readdirSync(dir, { withFileTypes: true })) ?? []) {
    if (!project.isDirectory()) continue;
    const folder = path.join(dir, project.name);
    for (const entry of gone(() => fs.readdirSync(folder, { withFileTypes: true })) ?? []) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, entry.name);
      const stat = gone(() => fs.statSync(file));
      if (stat) out.push({ file, project: project.name, mtimeMs: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Whether a transcript holds a prompt the user typed, from its first megabyte: a session a
// script started (`claude -p`) never does. Cheap enough for the start-of-session check.
export function hasTypedPrompt(file, limit = 1024 * 1024) {
  const fd = gone(() => fs.openSync(file, 'r'));
  if (fd === null) return false;
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let carry = '';
    for (let pos = 0; pos < limit; ) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (!n) return false;
      const text = carry + chunk.toString('latin1', 0, n);
      if (text.includes('"origin":{"kind":"human"}') || text.includes('"turnOrigin":"human"')) return true;
      carry = text.slice(-32);
      pos += n;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

// The typed text a row holds, or why it holds none: `skip` names what was left out, and is
// null for rows that are not messages at all.
export function typedText(row) {
  if (row.type === 'attachment') {
    const attachment = row.attachment;
    if (attachment?.type !== 'queued_command') return { skip: null };
    if (attachment.origin?.kind !== 'human') return { skip: 'notifications and messages from other sessions' };
    return { raw: textOf(attachment.prompt), id: attachment.source_uuid ?? row.uuid, at: attachment.timestamp ?? row.timestamp };
  }
  if (row.type !== 'user') return { skip: null };
  const content = row.message?.content;
  if (row.isSidechain) return { skip: 'subagent messages' };
  if (row.toolUseResult || (Array.isArray(content) && content.some((part) => part?.type === 'tool_result'))) return { skip: 'tool output' };
  if (row.isCompactSummary) return { skip: 'compaction summaries' };
  if (row.isMeta) return { skip: 'skill and system text' };
  const origin = row.origin?.kind ?? row.turnOrigin;
  if (origin === 'sdk') return { skip: 'turns a script started' };
  if (origin && origin !== 'human') return { skip: 'notifications and messages from other sessions' };
  return { raw: textOf(content), id: row.uuid, at: row.timestamp };
}

// A slash command is kept only for what was typed after it, and only when that is a sentence
// ("/loop check the deploy every hour"), not a setting ("/model opus").
export function cleanPrompt(raw) {
  const command = /<command-name>/.test(raw);
  let text = raw.replace(/<pasted_content(?:\s[^>]*)?>[\s\S]*?<\/pasted_content(?:\s[^>]*)?>/g, '[pasted text left out]');
  for (const tag of DROP_TAGS) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}(?:\\s[^>]*)?>`, 'g'), '');
  text = text.replace(/<command-args>([\s\S]*?)<\/command-args>/g, '$1').trim();
  if (command && text.split(/\s+/).filter(Boolean).length < 3) return { skip: 'commands and their output' };
  if (!text) return { skip: 'commands and their output' };
  if (/^\[Request interrupted/.test(text)) return { skip: 'interruptions' };
  return { text: redact(text).replace(/\n{3,}/g, '\n\n') };
}

export function familiesOf(text) {
  return FAMILIES.filter((family) => family.re.test(text)).map((family) => family.id);
}

function tail(text, max) {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function bump(counts, what) {
  counts[what] = (counts[what] ?? 0) + 1;
}

// One transcript. `seen` is shared across sessions: a resumed session copies earlier messages
// into its new file, and each prompt counts once.
export async function readSession({ file, project }, seen) {
  const prompts = [];
  const left = {};
  let lastReply = '';
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      bump(left, 'unreadable lines');
      continue;
    }
    if (row.type === 'assistant') {
      const reply = row.isSidechain ? '' : textOf(row.message?.content);
      if (reply.trim()) lastReply = reply;
      continue;
    }
    const found = typedText(row);
    if (found.skip !== undefined) {
      if (found.skip) bump(left, found.skip);
      continue;
    }
    const cleaned = cleanPrompt(found.raw);
    if (cleaned.skip) {
      bump(left, cleaned.skip);
      continue;
    }
    const ids = [found.id && `id\0${found.id}`, `text\0${found.at}\0${cleaned.text}`].filter(Boolean);
    if (ids.some((id) => seen.has(id))) {
      bump(left, 'repeated copies of a prompt');
      continue;
    }
    for (const id of ids) seen.add(id);
    const pushback = PUSHBACK.test(cleaned.text);
    // Redacted before it is cut, so a cut never separates a label from its value.
    prompts.push({ at: found.at ?? null, text: cleaned.text, families: familiesOf(cleaned.text), pushback, before: pushback && lastReply ? tail(redact(lastReply), 400) : null });
  }
  return { id: path.basename(file, '.jsonl'), project, prompts, left };
}

// The newest `count` sessions that hold at least one typed prompt.
export async function readRecent(dir, count) {
  const seen = new Set();
  const sessions = [];
  const left = {};
  let empty = 0;
  for (const entry of sessionFiles(dir)) {
    if (sessions.length >= count) break;
    const session = await readSession(entry, seen).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!session) continue;
    for (const [what, n] of Object.entries(session.left)) left[what] = (left[what] ?? 0) + n;
    if (session.prompts.length) sessions.push(session);
    else empty++;
  }
  const times = sessions.flatMap((s) => s.prompts.map((p) => p.at)).filter(Boolean).sort();
  return { sessions, left, empty, first: times[0] ?? null, last: times.at(-1) ?? null };
}

export function countMatching(sessions, test) {
  const perSession = sessions.map((s) => s.prompts.filter((p) => test(p)).length);
  return { prompts: perSession.reduce((a, b) => a + b, 0), sessions: perSession.filter(Boolean).length };
}

export function familyCounts(sessions) {
  return FAMILIES.map((family) => ({ id: family.id, label: family.label, ...countMatching(sessions, (p) => p.families.includes(family.id)) }));
}

const when = (at) => (at ? `${at.slice(0, 16).replace('T', ' ')}Z` : 'no time');

export function summary(result) {
  const prompts = result.sessions.reduce((n, s) => n + s.prompts.length, 0);
  const left = Object.entries(result.left).sort((a, b) => b[1] - a[1]).map(([what, n]) => `${n} ${what}`).join(', ');
  const lines = [
    `Read ${result.sessions.length} session(s) with prompts you typed, ${when(result.first)} to ${when(result.last)}: ${prompts} prompt(s). Newest prompt: ${result.last ?? 'none'}.`,
    `Left out: ${left || 'nothing'}. Session files with no typed prompt, skipped: ${result.empty}.`,
    'Phrase families (a prompt counts once per family):',
    ...familyCounts(result.sessions).map((f) => `  ${String(f.prompts).padStart(4)} prompt(s), ${String(f.sessions).padStart(2)} session(s)  ${f.label}`),
  ];
  const stacked = countMatching(result.sessions, (p) => p.families.length >= 3);
  const pushback = countMatching(result.sessions, (p) => p.pushback);
  lines.push(`Three or more families in one prompt: ${stacked.prompts} prompt(s) in ${stacked.sessions} session(s).`);
  lines.push(`Possible pushback: ${pushback.prompts} prompt(s) in ${pushback.sessions} session(s).`);
  return lines.join('\n');
}

export function renderWords(result) {
  const out = [
    '# Prompts you typed',
    '',
    'Only what was typed, plus the end of the reply before each possible pushback. Anything that looked like a key, token, password, email or phone number is replaced (best effort).',
    '',
    '```',
    summary(result),
    '```',
  ];
  result.sessions.forEach((session, i) => {
    const times = session.prompts.map((p) => p.at).filter(Boolean).sort();
    out.push('', `## Session ${i + 1} · ${session.project} · ${session.id.slice(0, 8)} · ${when(times[0])} to ${when(times.at(-1))} · ${session.prompts.length} prompt(s)`);
    session.prompts.forEach((prompt, j) => {
      const tags = [...prompt.families, ...(prompt.pushback ? ['possible pushback'] : [])];
      out.push('', `### ${i + 1}.${j + 1} · ${when(prompt.at)}${tags.length ? ` · ${tags.join(', ')}` : ''}`);
      if (prompt.before) out.push('', `> The reply before it ended: ${prompt.before.replace(/\s+/g, ' ')}`);
      out.push('', prompt.text);
    });
  });
  return out.join('\n') + '\n';
}

export const STALE_AFTER_MS = 6 * 3600_000;

// A run the skill never finished (the user stopped answering) leaves its file behind, and
// nothing empties the temp folder on Windows: each new run removes files older than 6 hours.
export function removeStaleWordsFiles(now = Date.now()) {
  const removed = [];
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!WORDS_FILE.test(name)) continue;
    const file = path.join(os.tmpdir(), name);
    const stat = gone(() => fs.lstatSync(file));
    if (stat?.isFile() && now - stat.mtimeMs > STALE_AFTER_MS) {
      gone(() => fs.unlinkSync(file));
      removed.push(file);
    }
  }
  return removed;
}

export function writeWordsFile(result) {
  const file = path.join(os.tmpdir(), `first-pass-words-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(file, renderWords(result), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}

// Deletes a file `writeWordsFile` wrote, and nothing else. A name that matches no file is an
// error, so a mistyped name never reads as "deleted" while the real file stays.
export function deleteWordsFile(file) {
  const abs = path.resolve(file);
  if (!WORDS_FILE.test(path.basename(abs)) || pathKey(path.dirname(abs)) !== pathKey(os.tmpdir())) {
    throw new Error(`${file} is not a words file first-pass wrote; nothing deleted`);
  }
  if (!gone(() => fs.lstatSync(abs))?.isFile()) throw new Error(`${file} was not found; nothing deleted`);
  fs.unlinkSync(abs);
}
