import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { migrateStrategy } from '../src/tools/migrateStrategy.js';
import { prepareRelease } from '../src/tools/prepareRelease.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { branchExists, commitAll, commitOn, createTestRepo, ctxFor, git, isMergedInto } from './helpers.js';

async function smallRepo(): Promise<string> {
  const dir = createTestRepo({ strategy: 'small', withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  return dir;
}

test('migrate: small -> large dry-runs by default and changes nothing', async () => {
  const dir = await smallRepo();

  const output = await migrateStrategy(await ctxFor(dir), { to: 'large' });

  assert.match(output, /plan only/);
  assert.match(output, /"develop" created from "release"/);
  assert.ok(!branchExists(dir, 'develop'));
  assert.equal(JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8')).strategy, 'small');
  assert.ok(existsSync(join(dir, '.github/workflows/release.yml')));
});

test('migrate: small -> large carries release into develop and swaps the workflows', async () => {
  const dir = await smallRepo();
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: in-flight work');
  const releaseHead = git(dir, 'rev-parse', 'release');

  const output = await migrateStrategy(await ctxFor(dir), { to: 'large', dryRun: false });

  assert.match(output, /strategy small -> large/);
  assert.ok(branchExists(dir, 'develop'));
  assert.ok(isMergedInto(dir, releaseHead, 'develop'), 'in-flight work must survive the migration');

  const config = JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8'));
  assert.equal(config.strategy, 'large');
  assert.equal(config.branches.development, 'develop');

  assert.ok(existsSync(join(dir, '.github/workflows/release-candidate.yml')));
  assert.ok(existsSync(join(dir, '.github/workflows/production.yml')));
  assert.ok(!existsSync(join(dir, '.github/workflows/release.yml')), 'the small-only workflow should be retired');

  assert.ok(branchExists(dir, 'release'), 'migrate_strategy must never delete a branch on its own');
  assert.match(output, /"release" left in place/);
  assert.match(output, /must be deleted before the first release/, 'the release ref conflict must be called out');
});

test('migrate: large -> small requires explicit confirmation', async () => {
  const dir = await smallRepo();
  await migrateStrategy(await ctxFor(dir), { to: 'large', dryRun: false });
  commitAll(dir, 'chore: migrate to large');

  const output = await migrateStrategy(await ctxFor(dir), { to: 'small', dryRun: false });

  assert.match(output, /confirmation required/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8')).strategy, 'large');
});

test('migrate: large -> small is blocked while a release candidate is in flight', async () => {
  const dir = await smallRepo();
  await migrateStrategy(await ctxFor(dir), { to: 'large', dryRun: false });
  commitAll(dir, 'chore: migrate to large');
  git(dir, 'branch', '-d', 'release');
  git(dir, 'branch', 'release/2.0.0', 'develop');

  const output = await migrateStrategy(await ctxFor(dir), { to: 'small', dryRun: false, confirm: true });

  assert.match(output, /blocked/);
  assert.match(output, /release\/2\.0\.0/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8')).strategy, 'large');
});

test('migrate: after small -> large, prepare_release explains the blocking "release" branch', async () => {
  const dir = await smallRepo();
  commitOn(dir, 'release', 'Feature.swift', 'let feature = true\n', 'feat: work');
  await migrateStrategy(await ctxFor(dir), { to: 'large', dryRun: false });
  commitAll(dir, 'chore: migrate to large');

  const output = await prepareRelease(await ctxFor(dir), { version: '2.0.0' });

  assert.match(output, /blocking "release\/\*" refs/);
  assert.match(output, /Not ready/);
  assert.ok(!branchExists(dir, 'release/2.0.0'));
});

test('migrate: setup_repository never switches an existing strategy', async () => {
  const dir = await smallRepo();

  const output = await setupRepository(await ctxFor(dir), { strategy: 'large', configureBranchProtection: false });

  assert.match(output, /never changes a repository's strategy/);
  assert.match(output, /migrate_strategy/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8')).strategy, 'small');
  assert.ok(!branchExists(dir, 'develop'));
});

test('migrate: a legacy .appdev.yml repository is adopted without losing its settings', async () => {
  const dir = createTestRepo({ withProject: true });
  writeFileSync(
    join(dir, '.appdev.yml'),
    [
      'version: 1',
      'project:',
      '  path: App.xcodeproj',
      '  scheme: App',
      'workflow:',
      '  production_branch: main',
      '  development_branch: release',
      '  hotfix_prefix: hotfix/',
    ].join('\n'),
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: legacy config');

  const output = await setupRepository(await ctxFor(dir), { strategy: 'small', configureBranchProtection: false });

  assert.match(output, /migrated settings from \.appdev\.yml/);
  const config = JSON.parse(readFileSync(join(dir, '.app-dev-mcp.json'), 'utf-8'));
  assert.equal(config.strategy, 'small');
  assert.equal(config.project.scheme, 'App');
  assert.ok(existsSync(join(dir, '.appdev.yml')), 'the legacy file is left for the user to delete');
});
