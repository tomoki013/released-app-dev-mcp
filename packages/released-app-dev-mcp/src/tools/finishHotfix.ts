import {
  createPullRequest,
  findOpenPullRequest,
  formatChecklist,
  isValidSemver,
  tagForVersion,
  type ValidationCheck,
} from '@app-dev/git-core';
import { ciCheck, cleanWorktreeCheck } from '../core/checks.js';
import { requireManaged, resolveGitHubClient, resolveProject, type ProjectContext } from '../core/context.js';
import { formatMergeOutcome, hasBlockingOutcome, syncTargets } from '../core/merge.js';
import { cleanupBranch, createProductionTag, mergeIntoProduction } from '../core/release.js';
import { recordPublished } from '../core/state.js';
import { resolveHotfixBranch } from './startHotfix.js';

export interface FinishHotfixOptions {
  name: string;
  version?: string;
  dryRun?: boolean;
  deleteBranch?: boolean;
}

/**
 * Two-phase by design. While the fix is not yet on the production lineage this
 * opens (or points at) the PR and stops. Once it is merged — by that PR, or by
 * this tool when GitHub isn't reachable — it tags the published version and
 * syncs the fix into every branch that would otherwise revert it.
 */
export async function finishHotfix(ctx: ProjectContext, opts: FinishHotfixOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  const strategy = ctx.strategy;
  const production = strategy.productionBranch;
  const branch = await resolveHotfixBranch(ctx, opts);
  if (!branch) {
    return `No hotfix branch found for "${opts.name}". Run start_hotfix first.`;
  }

  const version = opts.version ?? versionFromBranch(ctx, branch);
  const syncs = await strategy.hotfixSyncTargets(ctx);

  if (opts.dryRun) {
    return [
      `finish_hotfix(name: "${opts.name}", dry_run: true)  [strategy: ${strategy.name}]`,
      '',
      `Hotfix branch: ${branch}`,
      'Would:',
      '  1. check clean working tree and green CI',
      `  2. open (or reuse) the PR "${branch}" -> "${production}", or merge locally when GitHub is unreachable`,
      version
        ? `  3. once merged: tag "${tagForVersion(version)}" on "${production}"`
        : '  3. once merged: tag the published version (pass version: "x.y.z")',
      ...syncs.map((s, i) => `  ${i + 4}. merge "${production}" into "${s.branch}" — ${s.reason}`),
      '',
      'No changes were made.',
    ].join('\n');
  }

  const branchSha = await ctx.git.revParse(branch);
  const alreadyMerged = branchSha ? await ctx.git.isAncestor(branchSha, production) : false;

  if (!alreadyMerged) {
    const checks: ValidationCheck[] = [await cleanWorktreeCheck(ctx), await ciCheck(ctx, branch)];
    const result = { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
    if (!result.ok) return formatChecklist(`${branch} readiness`, result);

    if (ctx.githubToken && (await ctx.git.hasRemote())) {
      const github = await resolveGitHubClient(ctx);
      const existing = await findOpenPullRequest(github, branch, production);
      const pr =
        existing ??
        (await createPullRequest(github, {
          head: branch,
          base: production,
          title: `Hotfix: ${branch.replace(ctx.config.branches.hotfixPrefix, '')}`,
          body: await hotfixPrBody(ctx, branch, production, version, syncs.map((s) => s.branch)),
        }));
      return [
        formatChecklist(`${branch} readiness`, result),
        '',
        existing ? `Hotfix PR already open: #${pr.number} ${pr.url}` : `Created hotfix PR #${pr.number}: ${pr.url}`,
        '',
        'Merge that PR (and ship the build), then re-run finish_hotfix to tag the published',
        `version and sync the fix into: ${syncs.map((s) => s.branch).join(', ')}.`,
      ].join('\n');
    }

    // No GitHub reachable: land it here rather than leaving the fix stranded.
    const merge = await mergeIntoProduction(ctx, branch);
    if (merge.outcome && (merge.outcome.kind === 'conflict' || merge.outcome.kind === 'failed')) {
      return [formatMergeOutcome(merge.outcome), '', 'Nothing was tagged or synced.'].join('\n');
    }
  }

  const lines = [`Hotfix "${branch}" is merged into "${production}".`, ''];

  if (version && isValidSemver(version)) {
    const productionCommit = await ctx.git.revParse(production);
    const project = await resolveProject(ctx);
    const tagResult = await createProductionTag(
      ctx,
      version,
      [
        `Hotfix release ${version}`,
        '',
        `Build: ${project?.buildNumber ?? 'unknown'}`,
        `Strategy: ${strategy.name}`,
        `Source: ${branch}`,
        `Commit: ${productionCommit ?? 'unknown'}`,
      ].join('\n'),
      productionCommit ?? undefined,
    );
    if (tagResult.error) {
      lines.push(`✗ ${tagResult.error}`);
    } else {
      lines.push(
        tagResult.created
          ? `✓ tagged "${tagResult.tag}"${tagResult.pushed ? ' and pushed' : ' (not pushed — no remote)'}`
          : `✓ "${tagResult.tag}" already points at this commit`,
      );
      recordPublished(ctx.cwd, {
        version,
        tag: tagResult.tag,
        build: project?.buildNumber ?? null,
        commit: productionCommit ?? '',
        strategy: strategy.name,
        sourceBranch: branch,
        publishedAt: new Date().toISOString(),
      });
    }
  } else {
    lines.push(
      '⚠ no version given — production tag skipped.',
      `   Re-run with version: "x.y.z" once the hotfix build is live on the App Store.`,
    );
  }

  const outcomes = await syncTargets(ctx.git, production, syncs, { push: true });
  outcomes.forEach((outcome, i) => lines.push(formatMergeOutcome(outcome, syncs[i].reason)));

  lines.push(await cleanupBranch(ctx, branch, opts.deleteBranch ?? false));

  if (hasBlockingOutcome(outcomes)) {
    lines.push(
      '',
      '⚠ The fix is on the production lineage but did NOT reach every branch above.',
      '   Resolve those merges manually — otherwise the next release will revert the hotfix.',
    );
  }
  return lines.join('\n');
}

function versionFromBranch(ctx: ProjectContext, branch: string): string | undefined {
  const suffix = branch.slice(ctx.config.branches.hotfixPrefix.length);
  return isValidSemver(suffix) ? suffix : undefined;
}

async function hotfixPrBody(
  ctx: ProjectContext,
  branch: string,
  production: string,
  version: string | undefined,
  syncTargetNames: string[],
): Promise<string> {
  const commits = await ctx.git.logRange(`${production}..${branch}`);
  return [
    `## Hotfix${version ? ` ${version}` : ''}`,
    '',
    '### Commits',
    ...commits.map((c) => `- ${c.message.split('\n')[0]}`),
    '',
    `After merging, run \`finish_hotfix\` so the fix is tagged and synced into: ${syncTargetNames.join(', ')}.`,
  ].join('\n');
}
