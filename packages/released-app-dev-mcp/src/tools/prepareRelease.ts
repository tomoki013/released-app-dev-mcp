import { formatChecklist, type ValidationCheck, type ValidationResult } from '@app-dev/git-core';
import { cleanWorktreeCheck, ciCheck, secretsCheck, versionChecks } from '../core/checks.js';
import { requireManaged, resolveProject, type ProjectContext } from '../core/context.js';
import { recordCandidate } from '../core/state.js';

export interface PrepareReleaseOptions {
  version: string;
  dryRun?: boolean;
}

export async function prepareRelease(ctx: ProjectContext, opts: PrepareReleaseOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  const strategy = ctx.strategy;
  const plan = strategy.releaseBranchPlan(opts.version);
  const production = strategy.productionBranch;

  if (!(await ctx.git.isRepo())) return 'This directory is not a Git repository.';

  const branchExists = await ctx.git.localBranchExists(plan.branch);

  if (opts.dryRun) {
    return [
      `prepare_release(version: "${opts.version}", dry_run: true)  [strategy: ${strategy.name}]`,
      '',
      branchExists
        ? `Release candidate branch: "${plan.branch}" (already exists)`
        : plan.createIfMissing
          ? `Would create release candidate branch "${plan.branch}" from "${plan.source}"`
          : `"${plan.branch}" does not exist and this strategy does not create it — run setup_repository`,
      '',
      'Would check:',
      '  1. clean working tree',
      `  2. "${production}" branch exists`,
      `  3. version "${opts.version}" is valid semver, newer than the published version, and its tag is free`,
      `  4. "${plan.branch}" carries the latest "${production}" (no dropped hotfix)`,
      '  5. no credential files in the release diff',
      '  6. CI is green',
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checks: ValidationCheck[] = [];

  const productionExists = await ctx.git.localBranchExists(production);
  checks.push({
    id: 'production_exists',
    label: `"${production}" branch exists`,
    ok: productionExists,
    severity: 'error',
  });

  checks.push(await cleanWorktreeCheck(ctx));
  checks.push(...(await versionChecks(ctx, opts.version)));
  checks.push(...(await strategy.extraReleaseChecks(ctx, opts.version, plan)));

  const sourceForDiff = branchExists ? plan.branch : plan.source;
  if (productionExists && (await ctx.git.localBranchExists(sourceForDiff))) {
    checks.push(await secretsCheck(ctx, `${production}...${sourceForDiff}`));
  }
  checks.push(await ciCheck(ctx, sourceForDiff));

  const result: ValidationResult = { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
  const summary = formatChecklist(`Release ${opts.version} readiness (${strategy.name} strategy)`, result);
  if (!result.ok) return summary;

  const lines = [summary, ''];

  if (!branchExists && plan.createIfMissing) {
    const originalBranch = await ctx.git.currentBranch();
    await ctx.git.createBranch(plan.branch, plan.source);
    if (await ctx.git.hasRemote()) {
      try {
        await ctx.git.push(plan.branch);
        lines.push(`Created release candidate branch "${plan.branch}" from "${plan.source}" and pushed it.`);
      } catch (err: any) {
        lines.push(`Created "${plan.branch}" locally — push failed: ${err.message}`);
      }
    } else {
      lines.push(`Created release candidate branch "${plan.branch}" from "${plan.source}".`);
    }
    if (originalBranch && originalBranch !== plan.branch) {
      await ctx.git.checkout(originalBranch).catch(() => undefined);
    }
    lines.push(
      `From now until this release ships, "${plan.branch}" takes fixes only — new features go to "${plan.source}".`,
    );
  }

  const commit = (await ctx.git.revParse(plan.branch)) ?? '';
  const project = await resolveProject(ctx);
  recordCandidate(ctx.cwd, {
    version: opts.version,
    build: project?.buildNumber ?? null,
    commit,
    strategy: strategy.name,
    sourceBranch: plan.source,
    releaseBranch: plan.branch,
    createdAt: new Date().toISOString(),
  });

  lines.push(
    '',
    'Release candidate recorded:',
    `  Version: ${opts.version}`,
    `  Build:   ${project?.buildNumber ?? 'unknown'}`,
    `  Commit:  ${commit.slice(0, 7)}`,
    `  Branch:  ${plan.branch}`,
    `  Strategy: ${strategy.name}`,
    '',
    `Next: create_release_pr(version: "${opts.version}") — then submit the build via App Store Connect.`,
    'Once the version is live on the App Store, run finish_release to tag and sync.',
  );

  return lines.join('\n');
}
