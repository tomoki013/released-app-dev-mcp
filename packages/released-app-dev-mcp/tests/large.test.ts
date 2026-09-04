import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { finishHotfix } from '../src/tools/finishHotfix.js';
import { finishRelease } from '../src/tools/finishRelease.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { startHotfix } from '../src/tools/startHotfix.js';
import {
  branchExists,
  commitAll,
  commitOn,
  createTestRepo,
  ctxFor,
  currentBranch,
  fileOnBranch,
  git,
  isMergedInto,
  tags,
} from './helpers.js';

const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/internal-testflight.yml',
  '.github/workflows/release-candidate.yml',
  '.github/workflows/production.yml',
];

async function setupLarge(): Promise<string> {
  const dir = createTestRepo({ strategy: 'large', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  return dir;
}

test('large: setup creates develop and the large workflow set', async () => {
  const dir = await setupLarge();

  assert.ok(branchExists(dir, 'develop'));
  assert.ok(!branchExists(dir, 'release'), 'large must not create a permanent release branch');
  for (const path of WORKFLOWS) assert.ok(existsSync(join(dir, path)), `${path} should exist`);
  assert.equal(currentBranch(dir), 'main');
});

test('large: setup is idempotent', async () => {
  const dir = await setupLarge();
  const before = WORKFLOWS.map((p) => readFileSync(join(dir, p), 'utf-8'));

  const second = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  assert.match(second, /"develop" branch already exists/);
  assert.match(second, /ci\.yml already configured/);
  WORKFLOWS.forEach((p, i) => assert.equal(readFileSync(join(dir, p), 'utf-8'), before[i]));
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('large: prepare_release cuts release/X.Y.Z from develop', async () => {
  const dir = await setupLarge();
  commitOn(dir, 'feature/sharing', 'Sharing.swift', 'let shared = true\n', 'feat: sharing');
  git(dir, 'checkout', 'develop');
  git(dir, 'merge', '--no-ff', '-m', 'Merge feature/sharing', 'feature/sharing');
  git(dir, 'checkout', 'main');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.4.0' });

  assert.match(output, /Created release candidate branch "release\/1\.4\.0" from "develop"/);
  assert.ok(branchExists(dir, 'release/1.4.0'));
  assert.equal(currentBranch(dir), 'main', 'prepare_release must not leave you on another branch');
  assert.equal(fileOnBranch(dir, 'release/1.4.0', 'Sharing.swift'), 'let shared = true\n');
});

test('large: finish_release tags, syncs develop and retires the candidate branch', async () => {
  const dir = await setupLarge();
  commitOn(dir, 'develop', 'Sharing.swift', 'let shared = true\n', 'feat: sharing');
  await prepareRelease(await ctxFor(dir), { version: '1.4.0' });

  // A fix made on the frozen candidate must come back to develop.
  commitOn(dir, 'release/1.4.0', 'Fix.swift', 'let fixed = true\n', 'fix: release blocker');
  const candidateCommit = git(dir, 'rev-parse', 'release/1.4.0');

  const output = await finishRelease(await ctxFor(dir), { version: '1.4.0', deleteReleaseBranch: true });

  assert.match(output, /tagged "v1\.4\.0"/);
  assert.deepEqual(tags(dir), ['v1.4.0']);
  assert.ok(isMergedInto(dir, candidateCommit, 'main'));
  assert.ok(isMergedInto(dir, candidateCommit, 'develop'), 'release fixes must flow back to develop');
  assert.equal(fileOnBranch(dir, 'develop', 'Fix.swift'), 'let fixed = true\n');
  assert.ok(!branchExists(dir, 'release/1.4.0'), 'the temporary candidate branch should be gone');
});

test('large: finish_release keeps the candidate branch unless deletion is requested', async () => {
  const dir = await setupLarge();
  commitOn(dir, 'develop', 'Sharing.swift', 'let shared = true\n', 'feat: sharing');
  await prepareRelease(await ctxFor(dir), { version: '1.4.0' });

  const output = await finishRelease(await ctxFor(dir), { version: '1.4.0' });

  assert.match(output, /safe to delete: re-run with delete_release_branch: true/);
  assert.ok(branchExists(dir, 'release/1.4.0'));
});

test('large: a hotfix reaches develop and every in-flight release candidate', async () => {
  const dir = await setupLarge();
  git(dir, 'tag', '-a', 'v1.4.0', '-m', 'Release 1.4.0');
  commitOn(dir, 'develop', 'Next.swift', 'let next = true\n', 'feat: next version work');
  await prepareRelease(await ctxFor(dir), { version: '1.5.0' });

  await startHotfix(await ctxFor(dir), { name: 'crash on launch', version: '1.4.1' });
  writeFileSync(join(dir, 'Fix.swift'), 'let fixed = true\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'fix: crash on launch');
  const hotfixCommit = git(dir, 'rev-parse', 'hotfix/1.4.1');

  const output = await finishHotfix(await ctxFor(dir), { name: 'crash on launch', version: '1.4.1' });

  assert.match(output, /tagged "v1\.4\.1"/);
  assert.ok(isMergedInto(dir, hotfixCommit, 'main'));
  assert.ok(isMergedInto(dir, hotfixCommit, 'develop'), 'hotfix must reach develop');
  assert.ok(
    isMergedInto(dir, hotfixCommit, 'release/1.5.0'),
    'hotfix must reach the in-flight release candidate, or 1.5.0 would ship without it',
  );
  assert.match(output, /release\/1\.5\.0/);
});

test('large: a conflicting hotfix sync stops without touching the candidate', async () => {
  const dir = await setupLarge();
  commitOn(dir, 'develop', 'Shared.swift', 'develop value\n', 'feat: develop value');
  await prepareRelease(await ctxFor(dir), { version: '2.0.0' });
  commitOn(dir, 'release/2.0.0', 'Shared.swift', 'candidate value\n', 'fix: candidate value');
  const candidateHead = git(dir, 'rev-parse', 'release/2.0.0');

  await startHotfix(await ctxFor(dir), { name: 'urgent', version: '1.0.1' });
  writeFileSync(join(dir, 'Shared.swift'), 'hotfix value\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'fix: urgent');

  const output = await finishHotfix(await ctxFor(dir), { name: 'urgent', version: '1.0.1' });

  assert.match(output, /CONFLICT/);
  assert.match(output, /did NOT reach every branch/);
  assert.equal(git(dir, 'rev-parse', 'release/2.0.0'), candidateHead, 'the candidate must be untouched');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});
