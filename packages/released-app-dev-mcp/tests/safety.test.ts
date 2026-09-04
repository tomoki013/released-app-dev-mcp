import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { doctor } from '../src/tools/doctor.js';
import { finishRelease } from '../src/tools/finishRelease.js';
import { getAppStatus } from '../src/tools/getAppStatus.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { startHotfix } from '../src/tools/startHotfix.js';
import { syncRelease } from '../src/tools/syncRelease.js';
import { branchExists, commitAll, commitOn, createTestRepo, ctxFor, git, isMergedInto, tags } from './helpers.js';

async function readyRepo(): Promise<string> {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: something');
  return dir;
}

test('safety: a dirty working tree blocks prepare_release', async () => {
  const dir = await readyRepo();
  writeFileSync(join(dir, 'Scratch.swift'), 'uncommitted\n');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });

  assert.match(output, /✗ clean working tree/);
  assert.match(output, /Not ready/);
});

test('safety: an already-used production tag is never reused', async () => {
  const dir = await readyRepo();
  git(dir, 'tag', '-a', 'v1.1.0', '-m', 'Release 1.1.0');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.1.0' });

  assert.match(output, /production tag "v1\.1\.0" is not taken/);
  assert.match(output, /never overwritten/);
  assert.match(output, /Not ready/);
});

test('safety: finish_release refuses to move an existing tag', async () => {
  const dir = await readyRepo();
  const otherCommit = git(dir, 'rev-parse', 'main');
  git(dir, 'tag', '-a', 'v1.1.0', '-m', 'Release 1.1.0', otherCommit);
  commitOn(dir, 'release', 'More.swift', 'more\n', 'feat: more');

  const output = await finishRelease(await ctxFor(dir), { version: '1.1.0' });

  assert.match(output, /not taken/);
  assert.equal(git(dir, 'rev-parse', 'v1.1.0^{commit}'), otherCommit, 'the published tag must not move');
});

test('safety: a version that is not newer than the published one is rejected', async () => {
  const dir = await readyRepo();
  git(dir, 'tag', '-a', 'v2.0.0', '-m', 'Release 2.0.0');

  const output = await prepareRelease(await ctxFor(dir), { version: '1.5.0' });

  assert.match(output, /version is newer than the published 2\.0\.0/);
  assert.match(output, /Not ready/);
});

test('safety: a non-semver version is rejected', async () => {
  const dir = await readyRepo();

  const output = await prepareRelease(await ctxFor(dir), { version: 'v1.1' });

  assert.match(output, /is not in the form x\.y\.z/);
  assert.match(output, /Not ready/);
});

test('safety: a hotfix always starts from main, never from the branch you are on', async () => {
  const dir = await readyRepo();
  git(dir, 'checkout', 'release');

  await startHotfix(await ctxFor(dir), { name: 'urgent', version: '1.0.1' });

  assert.ok(branchExists(dir, 'hotfix/1.0.1'));
  assert.equal(
    git(dir, 'rev-parse', 'hotfix/1.0.1'),
    git(dir, 'rev-parse', 'main'),
    'the hotfix must be cut from the production lineage',
  );
});

test('safety: a dirty working tree blocks start_hotfix', async () => {
  const dir = await readyRepo();
  writeFileSync(join(dir, 'Scratch.swift'), 'uncommitted\n');

  const output = await startHotfix(await ctxFor(dir), { name: 'urgent' });

  assert.match(output, /✗ clean working tree/);
  assert.ok(!branchExists(dir, 'hotfix/urgent'));
});

test('safety: release tools refuse to act on an unmanaged repository', async () => {
  const dir = createTestRepo({ withProject: true });

  for (const output of [
    await prepareRelease(await ctxFor(dir), { version: '1.1.0' }),
    await finishRelease(await ctxFor(dir), { version: '1.1.0' }),
    await syncRelease(await ctxFor(dir), {}),
    await startHotfix(await ctxFor(dir), { name: 'urgent' }),
  ]) {
    assert.match(output, /unmanaged released app/);
    assert.match(output, /Run setup_repository/);
  }
  assert.deepEqual(tags(dir), []);
});

test('safety: an invalid strategy in the config is reported, not silently accepted', async () => {
  const dir = createTestRepo({ withProject: true });
  writeFileSync(
    join(dir, '.app-dev-mcp.json'),
    JSON.stringify({ schemaVersion: 1, lifecycle: 'released', strategy: 'medium', platform: 'ios' }),
  );

  const loaded = loadConfig(dir);
  assert.equal(loaded.config.strategy, 'small');
  assert.match(loaded.errors.join('\n'), /"strategy" must be "small" or "large"/);

  const status = await getAppStatus(await ctxFor(dir));
  assert.match(status, /must be "small" or "large"/);
});

test('safety: get_app_status tells an unmanaged repository to register first', async () => {
  const dir = createTestRepo({ withProject: true });

  const status = await getAppStatus(await ctxFor(dir));

  assert.match(status, /Managed:   NO/);
  assert.match(status, /Next action\n  Run setup_repository/);
});

test('safety: doctor reports an un-synced hotfix without repairing it', async () => {
  const dir = await readyRepo();
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0');
  commitOn(dir, 'hotfix/1.0.1', 'Fix.swift', 'let fixed = true\n', 'fix: urgent');
  git(dir, 'checkout', 'main');
  git(dir, 'merge', '--no-ff', '-m', 'Merge hotfix/1.0.1', 'hotfix/1.0.1');

  const output = await doctor(await ctxFor(dir));

  assert.match(output, /\[hotfix_unsynced\]/);
  assert.match(output, /Nothing was changed/);
  assert.ok(!isMergedInto(dir, 'hotfix/1.0.1', 'release'), 'doctor must not merge anything');
});

test('safety: doctor flags a direct commit to the production branch', async () => {
  const dir = await readyRepo();
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0');
  commitOn(dir, 'main', 'Oops.swift', 'let oops = true\n', 'fix: committed straight to main');

  const output = await doctor(await ctxFor(dir));

  assert.match(output, /\[direct_production_commit\]/);
});
