import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createReleasePr } from '../src/tools/createReleasePr.js';
import { doctor } from '../src/tools/doctor.js';
import { finishHotfix } from '../src/tools/finishHotfix.js';
import { finishRelease } from '../src/tools/finishRelease.js';
import { getAppStatus } from '../src/tools/getAppStatus.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { startHotfix } from '../src/tools/startHotfix.js';
import { syncRelease } from '../src/tools/syncRelease.js';
import { commitAll, commitOn, commitReleaseNotes, createTestRepo, ctxFor, git, isMergedInto } from './helpers.js';

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
  commitReleaseNotes(dir, 'develop');
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

test('release notes: prepare_release refuses a version whose "What\'s New" was never written', async () => {
  const dir = await readyRepo('small');
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: something users will see');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });

  assert.match(output, /✗ App Store "What's New" written for this version/);
  assert.match(output, /whats_new\.txt has not changed since v1\.0\.0/);
  assert.match(output, /CHANGELOG\.md has no "## 1\.1\.0" section/);
  assert.match(output, /Not ready/);
});

test('release notes: an unchanged whats_new.txt from the last release does not count', async () => {
  const dir = await readyRepo('small');
  commitReleaseNotes(dir, 'main', 'Old notes from 1.0.0.\n');
  git(dir, 'tag', '-f', '-a', 'v1.0.0', '-m', 'Release 1.0.0');
  git(dir, 'branch', '-f', 'release', 'main');
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: new work');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(output, /✗ App Store "What's New"/);

  commitReleaseNotes(dir, 'release', 'New in 1.1.0.\n');
  const retry = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(retry, /✓ App Store "What's New" written for this version — \.appstore\/ja\/whats_new\.txt updated since v1\.0\.0/);
  assert.match(retry, /Ready\./);
});

test('release notes: an empty whats_new.txt does not count', async () => {
  const dir = await readyRepo('small');
  commitReleaseNotes(dir, 'release', '\n');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(output, /✗ App Store "What's New"/);
});

test('release notes: a CHANGELOG.md section for the version is accepted instead', async () => {
  const dir = await readyRepo('small');
  commitOn(dir, 'release', 'CHANGELOG.md', '# Changelog\n\n## 1.1.0\n- Sharing sheet\n\n## 1.0.0\n- First release\n', 'docs: changelog');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(output, /✓ App Store "What's New" written for this version — CHANGELOG\.md on "release" has a 1\.1\.0 section/);
});

test('release notes: finish_hotfix opens no PR and merges nothing without them', async () => {
  const dir = await readyRepo('small');
  await startHotfix(await ctxFor(dir), { name: 'crash', version: '1.0.1' });
  writeFileSync(join(dir, 'Fix.swift'), 'let fixed = true\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'fix: crash');

  const output = await finishHotfix(await ctxFor(dir), { name: 'crash', version: '1.0.1' });

  assert.match(output, /✗ App Store "What's New"/);
  assert.ok(!isMergedInto(dir, 'hotfix/1.0.1', 'main'), 'the hotfix must not land without notes');
  assert.ok(!git(dir, 'tag', '--list').includes('v1.0.1'));
});

test('release notes: finish_release refuses to tag without them, and doctor warns first', async () => {
  const dir = await readyRepo('large');
  commitOn(dir, 'develop', 'Feature.swift', 'let feature = true\n', 'feat: work');
  commitReleaseNotes(dir, 'develop');
  await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  // Someone reverts the notes on the candidate before shipping.
  commitOn(dir, 'release/1.1.0', '.appstore/ja/whats_new.txt', '', 'chore: oops, blanked the notes');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.match(diagnosis, /\[release_notes_missing\] Candidate 1\.1\.0 on "release\/1\.1\.0"/);

  const output = await finishRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(output, /✗ App Store "What's New"/);
  assert.ok(!git(dir, 'tag', '--list').includes('v1.1.0'));
});

test('release notes: the requirement can be switched off per repository', async () => {
  const dir = await readyRepo('small');
  const configPath = join(dir, '.app-dev-mcp.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.release.requireReleaseNotes = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  commitAll(dir, 'chore: no release-notes gate');
  git(dir, 'branch', '-f', 'release', 'main');
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: work');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });
  assert.match(output, /✓ App Store "What's New" written for this version — requirement disabled/);
  assert.match(output, /Ready\./);
});

test('release notes: create_release_pr puts the What\'s New text in the PR body', async () => {
  const dir = await readyRepo('small');
  commitReleaseNotes(dir, 'release', 'You can now share trips.\n');
  await prepareRelease(await ctxFor(dir), { version: '1.1.0' });

  const output = await createReleasePr(await ctxFor(dir), { version: '1.1.0', dryRun: true });

  assert.match(output, /### What's New \(App Store\)/);
  assert.match(output, /\*\*ja\*\* \(`\.appstore\/ja\/whats_new\.txt`\)/);
  assert.match(output, /You can now share trips\./);
});
