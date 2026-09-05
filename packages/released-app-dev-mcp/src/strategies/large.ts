import type { ValidationCheck } from '@app-dev/git-core';
import { BaseStrategy } from './base.js';
import type { ReleaseBranchPlan, StrategyContext, SyncTarget } from './types.js';

/**
 * main + develop + a throwaway `release/X.Y.Z` per version. The release branch
 * is frozen for features once cut, which is what buys a stable candidate to
 * test migrations and backward compatibility against.
 */
export class LargeStrategy extends BaseStrategy {
  readonly name = 'large' as const;

  releaseBranchPlan(version: string): ReleaseBranchPlan {
    return {
      branch: `${this.config.branches.releasePrefix}${version}`,
      source: this.developmentBranch,
      createIfMissing: true,
      temporary: true,
    };
  }

  async postReleaseSyncTargets(_ctx: StrategyContext, _version: string): Promise<SyncTarget[]> {
    return [
      {
        branch: this.developmentBranch,
        reason: `carries release-branch fixes back into "${this.developmentBranch}"`,
        optional: false,
      },
    ];
  }

  /**
   * develop always; plus every release candidate still in flight — a hotfix
   * that isn't merged into an open `release/*` would be silently reverted when
   * that candidate ships.
   */
  async hotfixSyncTargets(ctx: StrategyContext): Promise<SyncTarget[]> {
    const targets: SyncTarget[] = [
      {
        branch: this.developmentBranch,
        reason: `so the fix is not lost in the next release from "${this.developmentBranch}"`,
        optional: false,
      },
    ];
    for (const branch of await activeReleaseBranches(ctx, this.config.branches.releasePrefix)) {
      targets.push({
        branch,
        reason: `"${branch}" is an in-flight release candidate that would otherwise ship without the fix`,
        optional: false,
      });
    }
    return targets;
  }

  releaseBranchCleanup(version: string): string | null {
    return `${this.config.branches.releasePrefix}${version}`;
  }

  override async extraReleaseChecks(
    ctx: StrategyContext,
    version: string,
    plan: ReleaseBranchPlan,
  ): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];

    const devExists = await ctx.git.localBranchExists(this.developmentBranch);
    checks.push({
      id: 'development_branch_exists',
      label: `"${this.developmentBranch}" branch exists`,
      ok: devExists,
      severity: 'error',
      detail: devExists ? undefined : 'run setup_repository',
    });

    const branchExists = await ctx.git.localBranchExists(plan.branch);
    if (!branchExists && devExists) {
      const diff = await ctx.git.aheadBehind(this.productionBranch, this.developmentBranch);
      checks.push({
        id: 'development_ahead',
        label: `"${this.developmentBranch}" has changes to release`,
        ok: diff.ahead > 0,
        severity: 'error',
        detail: `${diff.ahead} commit(s) ahead of "${this.productionBranch}"`,
      });
    }

    // Git cannot hold both refs/heads/release and refs/heads/release/1.4.0 —
    // a leftover "release" branch from the small strategy silently makes every
    // candidate branch impossible to create.
    const conflictingRef = this.config.branches.releasePrefix.replace(/\/$/, '');
    const refConflict = await ctx.git.localBranchExists(conflictingRef);
    checks.push({
      id: 'no_release_ref_conflict',
      label: `no "${conflictingRef}" branch blocking "${this.config.branches.releasePrefix}*" refs`,
      ok: !refConflict,
      severity: 'error',
      detail: refConflict
        ? `a branch named "${conflictingRef}" exists, so Git cannot create "${plan.branch}" — delete it once "${this.developmentBranch}" contains its work`
        : undefined,
    });

    const others = (await activeReleaseBranches(ctx, this.config.branches.releasePrefix)).filter(
      (b) => b !== plan.branch,
    );
    checks.push({
      id: 'no_other_active_release',
      label: 'no other release candidate in flight',
      ok: others.length === 0,
      severity: 'warning',
      detail: others.length ? `also active: ${others.join(', ')}` : undefined,
    });

    if (branchExists) {
      const diff = await ctx.git.aheadBehind(this.productionBranch, plan.branch);
      checks.push({
        id: 'production_merged_in',
        label: `latest "${this.productionBranch}" is included in "${plan.branch}"`,
        ok: diff.behind === 0,
        severity: 'error',
        detail:
          diff.behind === 0
            ? undefined
            : `missing ${diff.behind} commit(s) from "${this.productionBranch}" — an un-synced hotfix would be dropped by this release`,
      });
    }

    void version;
    return checks;
  }

  protected noDirectPushBranches(): string[] {
    return [this.productionBranch, this.developmentBranch, `${this.config.branches.releasePrefix}*`];
  }

  protected usesTemporaryReleaseBranch(): boolean {
    return true;
  }
}

/** Release candidate branches that exist locally or on origin. */
export async function activeReleaseBranches(ctx: StrategyContext, prefix: string): Promise<string[]> {
  const [local, remote] = await Promise.all([
    ctx.git.listLocalBranchesWithPrefix(prefix),
    ctx.git.listRemoteBranchesWithPrefix(prefix).catch(() => [] as string[]),
  ]);
  return [...new Set([...local, ...remote])].sort();
}
