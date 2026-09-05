import { requireManaged, type ProjectContext } from '../core/context.js';
import { formatMergeOutcome, hasBlockingOutcome, syncTargets } from '../core/merge.js';

export interface SyncReleaseOptions {
  dryRun?: boolean;
}

/**
 * Pushes the production lineage back down into the development line(s). What
 * "the development line" means is the strategy's call: `release` for small,
 * `develop` plus every in-flight `release/*` for large.
 */
export async function syncRelease(ctx: ProjectContext, opts: SyncReleaseOptions = {}): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  if (!(await ctx.git.isRepo())) return 'This directory is not a Git repository.';

  const production = ctx.strategy.productionBranch;
  if (!(await ctx.git.localBranchExists(production))) {
    return `Branch "${production}" does not exist locally.`;
  }

  const targets = await ctx.strategy.hotfixSyncTargets(ctx);

  if (opts.dryRun) {
    const previews: string[] = [];
    for (const target of targets) {
      if (!(await ctx.git.localBranchExists(target.branch))) {
        previews.push(`  — "${target.branch}" does not exist locally`);
        continue;
      }
      const preview = await ctx.git.previewMerge(target.branch, production);
      previews.push(`  ${target.branch}: ${preview.state}${preview.conflictingFiles.length ? ` (${preview.conflictingFiles.join(', ')})` : ''} — ${target.reason}`);
    }
    return [
      `sync_release(dry_run: true)  [strategy: ${ctx.strategy.name}]`,
      '',
      `Would merge "${production}" into:`,
      ...previews,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const tree = await ctx.git.workingTreeStatus();
  if (!tree.clean) return 'Working tree is not clean. Commit or stash your changes before syncing.';

  const outcomes = await syncTargets(ctx.git, production, targets, { push: true });
  const lines = [`sync_release  [strategy: ${ctx.strategy.name}]`, ''];
  outcomes.forEach((outcome, i) => lines.push(formatMergeOutcome(outcome, targets[i].reason)));

  if (hasBlockingOutcome(outcomes)) {
    lines.push('', '⚠ Resolve the conflicts above manually — nothing was force-merged.');
  }
  return lines.join('\n');
}
