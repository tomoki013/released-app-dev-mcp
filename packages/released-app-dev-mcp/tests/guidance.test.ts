import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { doctor } from '../src/tools/doctor.js';
import { getAppStatus } from '../src/tools/getAppStatus.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { syncRelease } from '../src/tools/syncRelease.js';
import { commitAll, commitOn, createTestRepo, ctxFor, git, isMergedInto } from './helpers.js';

async function readyRepo(strategy: 'small' | 'large'): Promise<string> {
  const dir = createTestRepo({ strategy, withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  // The development branch was cut before that commit; bring it level so the
  // .gitignore entry for the state file exists on every branch, as it would
  // after the first sync in real use.
  git(dir, 'branch', '-f', strategy === 'large' ? 'develop' : 'release', 'main');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0');
  return dir;
}

test('status: only release/X.Y.Z counts as an active release candidate', async () => {
  const dir = await readyRepo('large');
  git(dir, 'branch', 'release/build-41', 'develop');
  git(dir, 'branch', 'release/ipad', 'develop');

  const before = await getAppStatus(await ctxFor(dir));
  assert.match(before, /Active release branch: none/);
  assert.doesNotMatch(before, /release\/build-41/);

  git(dir, 'branch', 'release/1.2.0', 'develop');
  const after = await getAppStatus(await ctxFor(dir));
  assert.match(after, /Active release branch: release\/1\.2\.0\n/);
});

test('prepare_release: the dry run lists uncommitted files so they can be triaged first', async () => {
  const dir = await readyRepo('small');
  writeFileSync(join(dir, 'README.md'), '# Test app\n\nedited\n');
  writeFileSync(join(dir, 'New.swift'), 'let fresh = true\n');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0', dryRun: true });

  assert.match(output, /Uncommitted changes \(2\)/);
  assert.match(output, /modified   README\.md/);
  assert.match(output, /untracked  New\.swift/);
  assert.match(output, /feature\/\* branch/);
  assert.match(output, /No changes were made/);
});

test('doctor: lists what landed on a candidate after it was prepared', async () => {
  const dir = await readyRepo('large');
  commitOn(dir, 'develop', 'Feature.swift', 'let feature = true\n', 'feat: next release');
  const prepared = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(prepared, /Created release candidate branch "release\/1\.1\.0"/);

  const quiet = await doctor(await ctxFor(dir));
  assert.doesNotMatch(quiet, /release_branch_commits/);

  commitOn(dir, 'release/1.1.0', 'Fix.swift', 'let fixed = true\n', 'fix: crash on launch');
  commitOn(dir, 'release/1.1.0', 'Sneaky.swift', 'let feature = true\n', 'feat: sneak in a feature');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.match(diagnosis, /\[release_branch_commits\] "release\/1\.1\.0" has 2 commit\(s\) since candidate 1\.1\.0 was prepared/);
  assert.match(diagnosis, /fix: crash on launch/);
  assert.match(diagnosis, /feat: sneak in a feature/);
  assert.match(diagnosis, /Nothing was changed/);
});

test('sync_release: names feature branches that still miss the fix', async () => {
  const dir = await readyRepo('small');
  commitOn(dir, 'feature/ipad-adaptive', 'Ipad.swift', 'let ipad = true\n', 'feat: ipad layout');
  commitOn(dir, 'main', 'Fix.swift', 'let fixed = true\n', 'fix: hotfix landed on main');

  const output = await syncRelease(await ctxFor(dir), {});

  assert.ok(isMergedInto(dir, 'main', 'release'), 'release must receive the fix');
  assert.ok(!isMergedInto(dir, 'main', 'feature/ipad-adaptive'), 'feature branches are never merged into');
  assert.match(output, /feature\/\* branches are not synced automatically/);
  assert.match(output, /feature\/ipad-adaptive/);
  assert.match(output, /git merge release/);
});

test('sync_release: stays quiet about feature branches that already carry production', async () => {
  const dir = await readyRepo('small');
  commitOn(dir, 'main', 'Fix.swift', 'let fixed = true\n', 'fix: hotfix landed on main');
  commitOn(dir, 'feature/fresh', 'Fresh.swift', 'let fresh = true\n', 'feat: started after the fix');

  const output = await syncRelease(await ctxFor(dir), {});

  assert.doesNotMatch(output, /not synced automatically/);
});
