import type { ValidationCheck } from '@app-dev/git-core';
import { BaseStrategy } from './base.js';
import type { ReleaseBranchPlan, StrategyContext, SyncTarget } from './types.js';

/**
 * main + a long-lived `release` branch. Features land on `release`, and
 * `release` itself is the release candidate — there is no per-version branch.
 */
export class SmallStrategy extends BaseStrategy {
  readonly name = 'small' as const;

  releaseBranchPlan(_version: string): ReleaseBranchPlan {
    return {
      branch: this.developmentBranch,
      source: this.developmentBranch,
      createIfMissing: false,
      temporary: false,
    };
  }

  async postReleaseSyncTargets(_ctx: StrategyContext, _version: string): Promise<SyncTarget[]> {
    return [
      {
        branch: this.developmentBranch,
        reason: `keeps "${this.developmentBranch}" on top of the published production lineage`,
        optional: false,
      },
    ];
  }

  async hotfixSyncTargets(_ctx: StrategyContext): Promise<SyncTarget[]> {
    return [
      {
        branch: this.developmentBranch,
        reason: `so the fix is not lost in the next release from "${this.developmentBranch}"`,
        optional: false,
      },
    ];
  }

  releaseBranchCleanup(_version: string): string | null {
    return null; // `release` is permanent under this strategy.
  }

  override async extraReleaseChecks(
    ctx: StrategyContext,
    _version: string,
    plan: ReleaseBranchPlan,
  ): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];
    const exists = await ctx.git.localBranchExists(plan.branch);
    checks.push({
      id: 'release_branch_exists',
      label: `"${plan.branch}" branch exists`,
      ok: exists,
      severity: 'error',
      detail: exists ? undefined : 'run setup_repository',
    });
    if (!exists) return checks;

    const diff = await ctx.git.aheadBehind(this.productionBranch, plan.branch);
    checks.push({
      id: 'release_ahead',
      label: `"${plan.branch}" is ahead of "${this.productionBranch}"`,
      ok: diff.ahead > 0,
      severity: 'error',
      detail: `${diff.ahead} commit(s) ahead`,
    });
    checks.push({
      id: 'production_merged_in',
      label: `latest "${this.productionBranch}" is included in "${plan.branch}"`,
      ok: diff.behind === 0,
      severity: 'error',
      detail:
        diff.behind === 0
          ? undefined
          : `missing ${diff.behind} commit(s) from "${this.productionBranch}" — run sync_release (an un-synced hotfix would be dropped)`,
    });
    return checks;
  }

  protected noDirectPushBranches(): string[] {
    return [this.productionBranch, this.developmentBranch];
  }

  protected usesTemporaryReleaseBranch(): boolean {
    return false;
  }
}
