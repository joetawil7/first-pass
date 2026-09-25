// Claude Code never loads an `@import` of a `.mdc` file (only `.md`), so a CLAUDE.md that
// imports Cursor's `.cursor/rules/*.mdc` loads none of them. The fix keeps the `.mdc` as
// the source and imports a generated `.md` copy from `.claude/cursor-rules/`.
import fs from 'node:fs';
import path from 'node:path';

export const COPY_DIR = path.join('.claude', 'cursor-rules');
const IMPORT = /(^|\s)@([^\s`'"()]+\.mdc?)(?=\s|$)/gm;

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

// The rule text Claude should see: the `.mdc` without Cursor's frontmatter.
export function ruleBody(mdcText) {
  return normalize(mdcText)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\s+/, '');
}

// A copy's text without the "generated from" comment at its top, whatever wrote it.
function copyBody(text) {
  return normalize(text)
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replace(/^\s+/, '');
}

export function imports(claudeMd) {
  return [...normalize(claudeMd).matchAll(IMPORT)].map((m) => m[2]);
}

// `@./x` and `@x` name the same file.
function clean(target) {
  return target.replace(/^\.[\\/]/, '');
}

// Problems with a repo's Cursor-rule imports, one line each.
export function checkCursorRules(repoDir) {
  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return [];
  const problems = [];
  for (const target of imports(fs.readFileSync(claudeMdPath, 'utf8'))) {
    if (target.endsWith('.mdc')) {
      problems.push(`CLAUDE.md imports ${target}, and Claude Code never loads .mdc imports`);
      continue;
    }
    const copy = /^\.claude[\\/]cursor-rules[\\/](.+)\.md$/.exec(clean(target));
    if (!copy) continue;
    const source = path.join(repoDir, '.cursor', 'rules', `${copy[1]}.mdc`);
    const copyPath = path.join(repoDir, clean(target));
    if (!fs.existsSync(source)) problems.push(`${target} has no source .cursor/rules/${copy[1]}.mdc`);
    else if (!fs.existsSync(copyPath)) problems.push(`${target} is missing`);
    else if (copyBody(fs.readFileSync(copyPath, 'utf8')) !== ruleBody(fs.readFileSync(source, 'utf8'))) {
      problems.push(`${target} is out of date with .cursor/rules/${copy[1]}.mdc`);
    }
  }
  return problems;
}

// Points every `.mdc` import at a `.md` copy and writes the missing or stale copies.
// A copy that is already current is left byte for byte, and a stale copy keeps its own
// header comment, so a repo's own sync script and its check keep agreeing.
export function syncCursorRules(repoDir) {
  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return [];
  const changes = [];
  let claudeMd = fs.readFileSync(claudeMdPath, 'utf8');

  for (const target of imports(claudeMd)) {
    const mdc = /^\.cursor[\\/]rules[\\/](.+)\.mdc$/.exec(clean(target));
    if (!mdc) continue;
    const replacement = `.claude/cursor-rules/${mdc[1]}.md`;
    claudeMd = claudeMd.split(`@${target}`).join(`@${replacement}`);
    changes.push(`CLAUDE.md: @${target} → @${replacement}`);
  }
  if (changes.length) fs.writeFileSync(claudeMdPath, claudeMd);

  for (const target of imports(claudeMd)) {
    const copy = /^\.claude[\\/]cursor-rules[\\/](.+)\.md$/.exec(clean(target));
    if (!copy) continue;
    const source = path.join(repoDir, '.cursor', 'rules', `${copy[1]}.mdc`);
    if (!fs.existsSync(source)) continue;
    const body = ruleBody(fs.readFileSync(source, 'utf8'));
    const copyPath = path.join(repoDir, clean(target));
    const current = fs.existsSync(copyPath) ? fs.readFileSync(copyPath, 'utf8') : null;
    if (current !== null && copyBody(current) === body) continue;
    const header =
      normalize(current ?? '').match(/^<!--[\s\S]*?-->/)?.[0] ??
      `<!-- Generated from .cursor/rules/${copy[1]}.mdc by first-pass. Edit the .mdc, then re-run the first-pass setup (or its cursor-rules sync). -->`;
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, `${header}\n\n${body}`);
    changes.push(`${target} ${current === null ? 'written' : 'updated'}`);
  }
  return changes;
}
