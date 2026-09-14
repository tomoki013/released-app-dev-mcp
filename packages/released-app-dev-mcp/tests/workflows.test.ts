import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { doctor } from '../src/tools/doctor.js';
import { setupRepository } from '../src/tools/setupRepository.js';
import { commitAll, createTestRepo, ctxFor, git } from './helpers.js';

const CI = '.github/workflows/ci.yml';

function readCi(dir: string): string {
  return readFileSync(join(dir, CI), 'utf-8');
}

async function readyRepo(strategy: 'small' | 'large' = 'small'): Promise<string> {
  const dir = createTestRepo({ strategy, withProject: true });
  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  commitAll(dir, 'chore: add MCP workflows');
  return dir;
}

test('workflows: an XcodeGen project is generated before xcodebuild runs', async () => {
  const dir = createTestRepo({ strategy: 'large' });
  writeFileSync(join(dir, 'project.yml'), 'name: Remeet\ntargets:\n  Remeet:\n    type: application\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: xcodegen spec');

  const output = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  assert.match(output, /xcodegen project detected/);
  const ci = readCi(dir);
  assert.match(ci, /setup-xcode/);
  assert.match(ci, /brew install xcodegen/);
  assert.match(ci, /xcodegen generate/);
  assert.match(ci, /-project Remeet\.xcodeproj/);
  assert.match(ci, /-scheme Remeet/);
  assert.ok(ci.indexOf('xcodegen generate') < ci.indexOf('xcodebuild'), 'generate must precede the build');
  for (const file of ['internal-testflight.yml', 'release-candidate.yml', 'production.yml']) {
    assert.match(readFileSync(join(dir, '.github/workflows', file), 'utf-8'), /xcodegen generate/, file);
  }
});

test('workflows: a Tuist project is generated before xcodebuild runs', async () => {
  const dir = createTestRepo({ strategy: 'small' });
  writeFileSync(join(dir, 'Project.swift'), 'import ProjectDescription\nlet project = Project(name: "Remeet")\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: tuist spec');

  await setupRepository(await ctxFor(dir), { configureBranchProtection: false });

  const ci = readCi(dir);
  assert.match(ci, /tuist generate --no-open/);
  assert.match(ci, /-project Remeet\.xcodeproj/);
});

test('workflows: a committed .xcodeproj gets no generate step', async () => {
  const dir = await readyRepo();
  const ci = readCi(dir);
  assert.match(ci, /setup-xcode/);
  assert.doesNotMatch(ci, /xcodegen|tuist/);
  assert.match(ci, /^# template-version: \d+$/m);
});

test('workflows: a hand-edited managed workflow is kept, diffed on dry run, and replaced only on request', async () => {
  const dir = await readyRepo();
  const edited = readCi(dir).replace('      - name: Build', '      - name: Lint\n        run: swiftlint\n\n      - name: Build');
  writeFileSync(join(dir, CI), edited);
  commitAll(dir, 'ci: add lint step');

  const dryRun = await setupRepository(await ctxFor(dir), { configureBranchProtection: false, dryRun: true });
  assert.match(dryRun, /ci\.yml would be kept \(edited by hand/);
  assert.match(dryRun, /^\s+-\s+run: swiftlint$/m, 'the dry run must show what would be lost');
  assert.equal(readCi(dir), edited);

  const real = await setupRepository(await ctxFor(dir), { configureBranchProtection: false });
  assert.match(real, /⚠ ci\.yml differs from the template \(edited by hand/);
  assert.match(real, /overwrite_workflows: true/);
  assert.equal(readCi(dir), edited, 'setup_repository must not silently discard the edit');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.match(diagnosis, /\[workflow_edited\] \.github\/workflows\/ci\.yml/);
  assert.match(diagnosis, /\(customized\)/);

  const forced = await setupRepository(await ctxFor(dir), { configureBranchProtection: false, overwriteWorkflows: true });
  assert.match(forced, /ci\.yml updated \(edited by hand/);
  assert.doesNotMatch(readCi(dir), /swiftlint/);
});

test('workflows: a "(customized)" workflow is never regenerated', async () => {
  const dir = await readyRepo();
  const customized = readCi(dir)
    .replace(/^# managed-by: .*$/m, '# managed-by: released-app-dev-mcp (customized)')
    .replace('      - name: Build', '      - name: Lint\n        run: swiftlint\n\n      - name: Build');
  writeFileSync(join(dir, CI), customized);
  commitAll(dir, 'ci: customize');

  const output = await setupRepository(await ctxFor(dir), { configureBranchProtection: false, overwriteWorkflows: true });
  assert.match(output, /ci\.yml left as is \(marked customized\)/);
  assert.equal(readCi(dir), customized);

  const diagnosis = await doctor(await ctxFor(dir));
  assert.doesNotMatch(diagnosis, /workflow_edited|workflow_outdated/);
});

test('workflows: an older template version is reported as outdated, not as a hand edit', async () => {
  const dir = await readyRepo();
  writeFileSync(join(dir, CI), readCi(dir).replace(/^# template-version: \d+$/m, '# template-version: 1'));
  commitAll(dir, 'ci: pretend older template');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.match(diagnosis, /\[workflow_outdated\] .*template v1; the current template is v\d+/);
  assert.match(diagnosis, /overwrite_workflows: true/);

  const output = await setupRepository(await ctxFor(dir), { configureBranchProtection: false, dryRun: true });
  assert.match(output, /ci\.yml would be kept \(template v1 -> v\d+\)/);
});

test('doctor: the managed workflow set covers every branch that takes pull requests', async () => {
  const dir = await readyRepo('large');
  const diagnosis = await doctor(await ctxFor(dir));
  assert.doesNotMatch(diagnosis, /ci_pr_trigger_missing/);
});

test('doctor: flags a CI workflow whose pull_request trigger skips the development and candidate branches', async () => {
  const dir = await readyRepo('large');
  writeFileSync(
    join(dir, CI),
    ['name: CI', 'on:', '  pull_request:', '    branches:', '      - main', 'jobs:', '  build:', '    runs-on: macos-latest', '    steps:', '      - uses: actions/checkout@v4', ''].join('\n'),
  );
  commitAll(dir, 'ci: custom workflow that only tests main');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.match(diagnosis, /\[ci_pr_trigger_missing\] No workflow runs on pull requests into "develop", "release\/\*"/);
  assert.doesNotMatch(diagnosis, /into "main"/);
});

test('doctor: a workflow without a branch filter covers every pull request', async () => {
  const dir = await readyRepo('large');
  writeFileSync(
    join(dir, CI),
    ['name: CI', 'on: [pull_request, push]', 'jobs:', '  build:', '    runs-on: macos-latest', '    steps:', '      - uses: actions/checkout@v4', ''].join('\n'),
  );
  commitAll(dir, 'ci: run on every PR');

  const diagnosis = await doctor(await ctxFor(dir));
  assert.doesNotMatch(diagnosis, /ci_pr_trigger_missing/);
});
