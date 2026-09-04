import type { ValidationCheck } from '@app-dev/git-core';
import type { AppDevConfig, StrategyName } from '../core/config.js';
import type { BranchPolicy, ReleaseBranchPlan, Strategy, StrategyContext, SyncTarget } from './types.js';

/**
 * Everything Small and Large agree on: main is the production lineage, feature
 * branches never touch it, and release/hotfix branches are temporary. Only the
 * differences below are left abstract, which is what keeps `if (strategy ===
 * 'small')` out of the rest of the codebase.
 */
export abstract class BaseStrategy implements Strategy {
  abstract readonly name: StrategyName;

  constructor(protected readonly config: AppDevConfig) {}

  get productionBranch(): string {
    return this.config.branches.production;
  }

  get developmentBranch(): string {
    return this.config.branches.development;
  }

  branchPolicy(): BranchPolicy {
    return {
      permanent: [this.productionBranch, this.developmentBranch],
      noDirectPush: this.noDirectPushBranches(),
      featureTarget: this.developmentBranch,
      temporaryPrefixes: [
        this.config.branches.featurePrefix,
        'fix/',
        'chore/',
        this.config.branches.hotfixPrefix,
        ...(this.usesTemporaryReleaseBranch() ? [this.config.branches.releasePrefix] : []),
      ],
    };
  }

  hotfixSource(): string {
    // Config carries this so a misconfiguration is visible, but the production
    // lineage is the only correct answer for both strategies.
    return this.config.hotfix.source || this.productionBranch;
  }

  abstract releaseBranchPlan(version: string): ReleaseBranchPlan;
  abstract postReleaseSyncTargets(ctx: StrategyContext, version: string): Promise<SyncTarget[]>;
  abstract hotfixSyncTargets(ctx: StrategyContext): Promise<SyncTarget[]>;
  abstract releaseBranchCleanup(version: string): string | null;

  async extraReleaseChecks(
    _ctx: StrategyContext,
    _version: string,
    _plan: ReleaseBranchPlan,
  ): Promise<ValidationCheck[]> {
    return [];
  }

  protected abstract noDirectPushBranches(): string[];
  protected abstract usesTemporaryReleaseBranch(): boolean;
}
