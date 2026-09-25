// Folds the results of several hooks for one event into the single reply Claude Code
// reads, following its own rules: exit 2 blocks, JSON decides otherwise, a PreToolUse
// deny beats defer beats ask beats allow, and every context string reaches Claude.
// https://code.claude.com/docs/en/hooks#exit-code-output

const DECISION_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStop']);
const PLAIN_TEXT_IS_CONTEXT = new Set(['UserPromptSubmit', 'SessionStart']);
const PERMISSION_ORDER = ['deny', 'defer', 'ask', 'allow'];
// PreToolUse's deprecated top-level decision values, which Claude Code still honours.
const LEGACY_PERMISSION = { block: 'deny', approve: 'allow' };
// Claude Code caps each context string at 10,000 characters and shows Claude only a
// preview of a longer one, so the merged string stays under it.
export const CONTEXT_CAP = 9500;
const KNOWN_SPECIFIC = new Set(['hookEventName', 'additionalContext', 'permissionDecision', 'permissionDecisionReason', 'updatedInput']);

// Claude Code's reading of stdout: an object is JSON; several lines that each parse as
// JSON are plain text unless one of them sets a field (then it is a parse failure).
function parse(stdout) {
  const text = stdout.trim();
  if (!text) return { json: null, text: '' };
  if (!(text.startsWith('{') && text.endsWith('}'))) return { json: null, text };
  try {
    return { json: JSON.parse(text), text: '' };
  } catch (error) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
    if (lines.length > 1 && parsed.every((value) => value !== undefined)) {
      const setsField = parsed.some((value) => value && typeof value === 'object' && Object.keys(value).length);
      if (!setsField) return { json: null, text };
    }
    return { json: null, text: '', invalid: error.message };
  }
}

function withLabel(label, text) {
  return label && text ? `${label}: ${text}` : text;
}

// One result: { label, status, stdout, stderr, timedOut } from a process, or
// { label, json, own } from first-pass's own checks.
function verdict(event, result) {
  const v = { own: !!result.own, context: [], blocks: [], permission: null, updatedInput: null, stops: [], messages: [], extra: {}, universal: {} };
  const label = result.label ?? null;
  const name = result.name ?? label ?? 'hook';

  if (result.timedOut) {
    v.messages.push(`first-pass: ${name} timed out and was skipped`);
    return v;
  }
  const { json, text, invalid } = result.json ? { json: result.json, text: '' } : parse(result.stdout ?? '');
  const stderr = (result.stderr ?? '').trim();
  const status = result.json ? 0 : result.status;

  if (invalid) v.messages.push(`first-pass: ${name} printed invalid JSON (${invalid})`);
  if (text && PLAIN_TEXT_IS_CONTEXT.has(event) && status === 0) v.context.push(withLabel(label, text));

  if (json) {
    const specific = json.hookSpecificOutput ?? {};
    if (specific.additionalContext) v.context.push(withLabel(label, specific.additionalContext));
    if (event === 'PreToolUse') {
      const decision = specific.permissionDecision ?? LEGACY_PERMISSION[json.decision];
      if (decision) v.permission = { decision, reason: withLabel(label, specific.permissionDecisionReason ?? json.reason ?? '') };
    }
    if (specific.updatedInput) v.updatedInput = specific.updatedInput;
    for (const [field, value] of Object.entries(specific)) if (!KNOWN_SPECIFIC.has(field)) v.extra[field] = value;
    if (DECISION_EVENTS.has(event) && json.decision === 'block') v.blocks.push(withLabel(label, json.reason ?? ''));
    if (json.continue === false) v.stops.push(json.stopReason ?? '');
    if (json.systemMessage) v.messages.push(json.systemMessage);
    if (json.terminalSequence) v.universal.terminalSequence = json.terminalSequence;
  }

  if (status === 2) {
    // The blocking message is the JSON's own reason when it gives one, stderr otherwise.
    const reason = withLabel(label, stderr || 'blocked');
    if (event === 'PreToolUse') {
      if (v.permission?.decision !== 'deny' || !v.permission.reason) v.permission = { decision: 'deny', reason };
    } else if (DECISION_EVENTS.has(event)) {
      if (!v.blocks.length) v.blocks.push(reason);
    } else v.messages.push(`first-pass: ${name} failed: ${stderr.split('\n')[0]}`);
  } else if (status !== 0 && !json) {
    v.messages.push(`first-pass: ${name} failed (exit ${status})${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
  }
  return v;
}

// first-pass's own notices go first and whole; the rest share what is left of the cap.
function joinContexts(verdicts) {
  const own = verdicts.filter((v) => v.own).flatMap((v) => v.context);
  const others = verdicts.filter((v) => !v.own).flatMap((v) => v.context);
  const separators = 2 * Math.max(0, own.length + others.length - 1);
  const budget = CONTEXT_CAP - own.join('').length - separators;
  const total = others.reduce((sum, text) => sum + text.length, 0);
  let trimmed = others;
  if (others.length && total > budget) {
    const share = Math.max(200, Math.floor(budget / others.length) - 90);
    trimmed = others.map((text) =>
      text.length <= share ? text : `${text.slice(0, share)}\n[first-pass trimmed ${text.length - share} characters to stay under Claude Code's limit]`,
    );
  }
  return [...own, ...trimmed].join('\n\n');
}

export function merge(event, results) {
  const verdicts = results.map((result) => verdict(event, result));
  const context = joinContexts(verdicts);
  const blocks = verdicts.flatMap((v) => v.blocks);
  const stops = verdicts.flatMap((v) => v.stops);
  const messages = verdicts.flatMap((v) => v.messages);
  const extra = Object.assign({}, ...verdicts.map((v) => v.extra).reverse());
  const universal = Object.assign({}, ...verdicts.map((v) => v.universal).reverse());

  const out = { ...universal };
  const specific = { ...extra };

  if (event === 'PreToolUse') {
    const permissions = verdicts.map((v) => v.permission).filter(Boolean);
    const decision = PERMISSION_ORDER.find((d) => permissions.some((p) => p.decision === d));
    if (decision) {
      specific.permissionDecision = decision;
      const reasons = permissions.filter((p) => p.decision === decision && p.reason).map((p) => p.reason);
      if (reasons.length) specific.permissionDecisionReason = reasons.join('\n');
    }
    const updatedInput = verdicts.find((v) => v.updatedInput)?.updatedInput;
    if (updatedInput && decision !== 'deny') specific.updatedInput = updatedInput;
  }
  if (blocks.length) {
    out.decision = 'block';
    out.reason = blocks.join('\n\n');
  }
  if (context) specific.additionalContext = context;
  if (Object.keys(specific).length) out.hookSpecificOutput = { hookEventName: event, ...specific };
  if (stops.length) {
    out.continue = false;
    out.stopReason = stops.filter(Boolean).join('\n');
  }
  if (messages.length) out.systemMessage = messages.join('\n');
  return Object.keys(out).length ? out : null;
}
