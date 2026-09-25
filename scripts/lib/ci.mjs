// A repo's CI config: which files, a hash to notice when they change, and the shell
// commands their jobs run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { posix } from './paths.mjs';

const SINGLE_FILES = ['.gitlab-ci.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.buildkite/pipeline.yml'];

export function ciFiles(repoDir) {
  const files = [];
  const workflows = path.join(repoDir, '.github', 'workflows');
  if (fs.existsSync(workflows)) {
    for (const name of fs.readdirSync(workflows).sort()) {
      if (/\.ya?ml$/.test(name)) files.push(`.github/workflows/${name}`);
    }
  }
  for (const file of SINGLE_FILES) if (fs.existsSync(path.join(repoDir, file))) files.push(file);
  return files;
}

export function ciHash(repoDir) {
  const hash = crypto.createHash('sha256');
  for (const file of ciFiles(repoDir)) {
    hash.update(posix(file) + '\0');
    hash.update(fs.readFileSync(path.join(repoDir, file), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// The `run:` / `script:` commands of a YAML CI file, in order, with the job each sits in.
// A line reader, not a YAML parser: good enough to list commands for a person to check.
export function ciCommands(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let job = null;
  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) inJobs = /^jobs:\s*$/.test(line);
    const jobMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (jobMatch && inJobs) job = jobMatch[1];
    const run = /^(\s*)(?:-\s+)?(run|script):\s*(.*)$/.exec(line);
    if (!run) continue;
    const [, indent, , rest] = run;
    if (rest && !/^[|>][-+]?\s*$/.test(rest)) {
      if (!rest.startsWith('[')) out.push({ job, command: rest.replace(/^["']|["']$/g, '') });
      continue;
    }
    // A block: every following line indented deeper than the key, or a list of items.
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === '') {
        block.push('');
        continue;
      }
      if (next.length - next.trimStart().length <= indent.length) break;
      block.push(next.trim().replace(/^-\s+/, ''));
      i = j;
    }
    const command = block.join('\n').trim();
    if (command) out.push({ job, command });
  }
  return out;
}
