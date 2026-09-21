#!/usr/bin/env node
// Fails when source changed but CHANGELOG.md did not. Compares against
// CHANGELOG_BASE (CI passes the PR base / previous push), or origin/main.
import { execFileSync } from 'node:child_process';

const base = process.env.CHANGELOG_BASE || 'origin/main';
const SOURCE = /^packages\/[^/]+\/src\//;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

let range;
try {
  git('rev-parse', '--verify', '--quiet', base);
  range = `${base}...HEAD`;
} catch {
  console.log(`check-changelog: "${base}" not found — skipping.`);
  process.exit(0);
}

const committed = git('diff', '--name-only', range).split('\n');
const uncommitted = git('diff', '--name-only', 'HEAD').split('\n');
const staged = git('diff', '--name-only', '--cached').split('\n');
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
const changed = new Set([...committed, ...uncommitted, ...staged, ...untracked].filter(Boolean));

const sourceChanged = [...changed].filter((f) => SOURCE.test(f));
if (sourceChanged.length === 0) {
  console.log('check-changelog: no source changes.');
  process.exit(0);
}
if (changed.has('CHANGELOG.md')) {
  console.log('check-changelog: CHANGELOG.md updated.');
  process.exit(0);
}

console.error(
  [
    `check-changelog: ${sourceChanged.length} source file(s) changed since ${base} but CHANGELOG.md did not:`,
    ...sourceChanged.map((f) => `  ${f}`),
    '',
    'Add a line under "## Unreleased" in CHANGELOG.md describing the change.',
  ].join('\n'),
);
process.exit(1);
