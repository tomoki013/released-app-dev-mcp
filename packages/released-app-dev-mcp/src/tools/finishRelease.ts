import { formatChecklist, tagForVersion, type ValidationCheck } from '@app-dev/git-core';
import { cleanWorktreeCheck, versionChecks } from '../core/checks.js';
import { requireManaged, resolveProject, type ProjectContext } from '../core/context.js';
import { formatMergeOutcome, hasBlockingOutcome, syncTargets } from '../core/merge.js';
import { cleanupBranch, createProductionTag, mergeIntoProduction } from '../core/release.js';
import { findCandidate, loadState, recordPublished } from '../core/state.js';

export interface FinishReleaseOptions {
  version: string;
  dryRun?: boolean;
  deleteReleaseBranch?: boolean;
}

/**
 * Closes out the Git side AFTER the version is live on the App Store: merge to
 * the production lineage, tag the published commit, sync the fixes back, and
 * retire the temporary release branch. The tag is only ever created here, so a
 * `vX.Y.Z` tag always means "this shipped".
 */
export async function finishRelease(ctx: ProjectContext, opts: FinishReleaseOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  const strategy = ctx.strategy;
  const plan = strategy.releaseBranchPlan(opts.version);
  const production = strategy.productionBranch;
  const tag = tagForVersion(opts.version);
  const candidate = findCandidate(loadState(ctx.cwd), opts.version);

  if (opts.dryRun) {
    const syncs = await strategy.postReleaseSyncTargets(ctx, opts.version);
    const cleanup = strategy.releaseBranchCleanup(opts.version);
    return [
      `finish_release(version: "${opts.version}", dry_run: true)  [strategy: ${strategy.name}]`,
      '',
      'Would:',
      `  1. verify "${plan.branch}" is merged into "${production}" (merging it if the PR was not used)`,
      `  2. create annotated tag "${tag}" on "${production}" — never overwriting an existing tag`,
      '  3. push the tag',
      ...syncs.map((s, i) => `  ${i + 4}. merge "${production}" into "${s.branch}" — ${s.reason}`),
      cleanup
        ? `  ${syncs.length + 4}. report "${cleanup}" as deletable (deleted only with delete_release_branch: true)`
        : `  ${syncs.length + 4}. no temporary branch to clean up`,
      '',
      candidate
        ? `Recorded candidate: ${candidate.version} @ ${candidate.commit.slice(0, 7)} from ${candidate.releaseBranch}`
        : 'No prepared candidate recorded for this version (prepare_release was not run here).',
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checks: ValidationCheck[] = [await cleanWorktreeCheck(ctx)];
  const branchExists = await ctx.git.localBranchExists(plan.branch);
  checks.push({
    id: 'release_branch_exists',
    label: `"${plan.branch}" exists`,
    ok: branchExists,
    severity: 'error',
    detail: branchExists ? undefined : 'nothing to finish — was prepare_release run?',
  });
  // Only the "tag is free / version is newer" parts matter here; the branch
  // shape was already validated by prepare_release.
  checks.push(...(await versionChecks(ctx, opts.version)));

  if (candidate) {
    const head = await ctx.git.revParse(plan.branch);
    checks.push({
      id: 'candidate_commit_matches',
      label: 'release branch still points at the prepared commit',
      ok: head === candidate.commit,
      severity: 'warning',
      detail:
        head === candidate.commit
          ? undefined
          : `prepared ${candidate.commit.slice(0, 7)}, branch is now ${head?.slice(0, 7)} — the shipped build may differ`,
    });
  }

  const result = { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
  const lines = [formatChecklist(`Finish release ${opts.version} (${strategy.name} strategy)`, result)];
  if (!result.ok) return lines.join('\n');

  lines.push('');

  // 1. production merge
  const merge = await mergeIntoProduction(ctx, plan.branch);
  if (merge.alreadyMerged) {
    lines.push(`✓ "${plan.branch}" is already merged into "${production}"`);
  } else if (merge.outcome) {
    lines.push(formatMergeOutcome(merge.outcome));
    if (merge.outcome.kind === 'conflict' || merge.outcome.kind === 'failed') {
      lines.push('', 'Stopped before tagging — nothing was tagged or synced. Resolve the merge and re-run.');
      return lines.join('\n');
    }
  }

  // 2/3. production tag
  const project = await resolveProject(ctx);
  const productionCommit = await ctx.git.revParse(production);
  const tagResult = await createProductionTag(
    ctx,
    opts.version,
    [
      `Release ${opts.version}`,
      '',
      `Build: ${project?.buildNumber ?? candidate?.build ?? 'unknown'}`,
      `Strategy: ${strategy.name}`,
      `Source: ${plan.branch}`,
      `Commit: ${productionCommit ?? 'unknown'}`,
    ].join('\n'),
    productionCommit ?? undefined,
  );
  if (tagResult.error) {
    lines.push(`✗ ${tagResult.error}`);
    return lines.join('\n');
  }
  lines.push(
    tagResult.created
      ? `✓ tagged "${tagResult.tag}" at ${tagResult.commit?.slice(0, 7)}${tagResult.pushed ? ' and pushed' : ' (not pushed — no remote)'}`
      : `✓ "${tagResult.tag}" already points at this commit`,
  );

  // 4. strategy-specific sync back
  const targets = await strategy.postReleaseSyncTargets(ctx, opts.version);
  const outcomes = await syncTargets(ctx.git, production, targets, { push: true });
  outcomes.forEach((outcome, i) => lines.push(formatMergeOutcome(outcome, targets[i].reason)));

  // 5. temporary branch cleanup
  const cleanup = strategy.releaseBranchCleanup(opts.version);
  if (cleanup) lines.push(await cleanupBranch(ctx, cleanup, opts.deleteReleaseBranch ?? false));

  recordPublished(ctx.cwd, {
    version: opts.version,
    tag: tagResult.tag,
    build: project?.buildNumber ?? candidate?.build ?? null,
    commit: productionCommit ?? '',
    strategy: strategy.name,
    sourceBranch: plan.branch,
    publishedAt: new Date().toISOString(),
  });

  lines.push(
    '',
    `Release ${opts.version} is closed out in Git.`,
    `  Tag:    ${tagResult.tag}`,
    `  Commit: ${productionCommit?.slice(0, 7) ?? 'unknown'}`,
    `  Build:  ${project?.buildNumber ?? candidate?.build ?? 'unknown'}`,
  );
  if (hasBlockingOutcome(outcomes)) {
    lines.push('', '⚠ Some sync targets need manual resolution (see above) — do it before the next release.');
  }
  return lines.join('\n');
}
