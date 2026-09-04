import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { finishHotfix } from '../src/tools/finishHotfix.js';
import { finishRelease } from '../src/tools/finishRelease.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { startHotfix } from '../src/tools/startHotfix.js';
import { syncRelease } from '../src/tools/syncRelease.js';
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

test('small: setup creates the release branch, config and workflows', async () => {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  const output = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  assert.match(output, /"release" branch created from "main"/);
  assert.ok(branchExists(dir, 'release'));
  assert.ok(existsSync(join(dir, '.github/workflows/ci.yml')));
  assert.ok(existsSync(join(dir, '.github/workflows/release.yml')));
  assert.ok(existsSync(join(dir, '.github/pull_request_template.md')));
  assert.equal(currentBranch(dir), 'main', 'setup must leave the checked-out branch alone');
});

test('small: setup is idempotent', async () => {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  const ciBefore = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf-8');

  const second = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  assert.match(second, /"release" branch already exists/);
  assert.match(second, /ci\.yml already configured/);
  assert.equal(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf-8'), ciBefore);
  assert.equal(git(dir, 'branch', '--list', 'release').split('\n').length, 1);
});

test('small: an unregistered repository asks for an explicit strategy instead of guessing', async () => {
  const dir = createTestRepo({ withProject: true });
  const output = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  assert.match(output, /needs an explicit strategy/);
  assert.ok(!existsSync(join(dir, '.app-dev-mcp.json')));
  assert.ok(!branchExists(dir, 'release'));
});

test('small: feature -> release -> prepare_release -> finish_release tags and syncs', async () => {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');

  commitOn(dir, 'feature/greeting', 'Greeting.swift', 'let hello = "hi"\n', 'feat: add greeting');
  git(dir, 'checkout', 'release');
  git(dir, 'merge', '--no-ff', '-m', 'Merge feature/greeting', 'feature/greeting');
  git(dir, 'checkout', 'main');

  const prepared = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(prepared, /Ready\./);
  assert.match(prepared, /Release candidate recorded/);

  const state = JSON.parse(readFileSync(join(dir, '.app-dev-mcp.state.json'), 'utf-8'));
  assert.equal(state.candidates[0].version, '1.1.0');
  assert.equal(state.candidates[0].releaseBranch, 'release');

  const releasedCommit = git(dir, 'rev-parse', 'release');
  const finished = await finishRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(finished, /tagged "v1\.1\.0"/);

  assert.deepEqual(tags(dir), ['v1.1.0']);
  assert.ok(isMergedInto(dir, releasedCommit, 'main'), 'the released commit must be on main');
  assert.equal(git(dir, 'rev-parse', 'v1.1.0^{commit}'), git(dir, 'rev-parse', 'main'));
  assert.ok(isMergedInto(dir, 'main', 'release'), 'main must be synced back into release');
  assert.equal(fileOnBranch(dir, 'main', 'Greeting.swift'), 'let hello = "hi"\n');

  const published = JSON.parse(readFileSync(join(dir, '.app-dev-mcp.state.json'), 'utf-8')).published[0];
  assert.equal(published.tag, 'v1.1.0');
  assert.equal(published.strategy, 'small');
});

test('small: hotfix branches from main, tags, and syncs back into release', async () => {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0');

  // Unrelated work sitting on release must not end up in the hotfix.
  commitOn(dir, 'release', 'Feature.swift', 'next release work\n', 'feat: next release work');

  const started = await startHotfix(await ctxFor(dir), { name: 'startup crash', version: '1.0.1' });
  assert.match(started, /Created "hotfix\/1\.0\.1" from "main"/);
  assert.equal(currentBranch(dir), 'hotfix/1.0.1');
  assert.equal(fileOnBranch(dir, 'hotfix/1.0.1', 'Feature.swift'), null, 'hotfix must not carry release-only work');

  writeFileSync(join(dir, 'Fix.swift'), 'let fixed = true\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'fix: stop crashing at startup');

  const finished = await finishHotfix(await ctxFor(dir), { name: 'startup crash', version: '1.0.1' });
  assert.match(finished, /tagged "v1\.0\.1"/);

  assert.ok(tags(dir).includes('v1.0.1'));
  assert.ok(isMergedInto(dir, 'hotfix/1.0.1', 'main'));
  assert.ok(isMergedInto(dir, 'hotfix/1.0.1', 'release'), 'the fix must reach release too');
  assert.equal(fileOnBranch(dir, 'release', 'Fix.swift'), 'let fixed = true\n');
});

test('small: a conflicting sync stops and changes nothing', async () => {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');

  commitOn(dir, 'main', 'Shared.swift', 'let value = "from main"\n', 'fix: main value');
  commitOn(dir, 'release', 'Shared.swift', 'let value = "from release"\n', 'feat: release value');
  const releaseHeadBefore = git(dir, 'rev-parse', 'release');

  const output = await syncRelease(await ctxFor(dir), {});

  assert.match(output, /CONFLICT/);
  assert.match(output, /Shared\.swift/);
  assert.equal(git(dir, 'rev-parse', 'release'), releaseHeadBefore, 'release must be untouched');
  assert.equal(fileOnBranch(dir, 'release', 'Shared.swift'), 'let value = "from release"\n');
  assert.ok(git(dir, 'status', '--porcelain') === '', 'working tree must be left clean');
});
