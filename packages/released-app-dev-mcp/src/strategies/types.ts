import type { GitClient, ValidationCheck } from '@app-dev/git-core';
import type { AppDevConfig, StrategyName } from '../core/config.js';

/**
 * The slice of the project context a strategy is allowed to see. Strategies
 * decide *which branches* things happen on; they never run Git themselves —
 * `git` is here only for read-only questions like "does this branch exist?".
 */
export interface StrategyContext {
  cwd: string;
  config: AppDevConfig;
  git: GitClient;
}

export interface BranchPolicy {
  /** Branches that must always exist. */
  permanent: string[];
  /** Branches that must never be pushed to directly. */
  noDirectPush: string[];
  /** Where feature/fix/chore branches are merged. */
  featureTarget: string;
  temporaryPrefixes: string[];
}

/** Where a release candidate for `version` lives, and how it gets there. */
export interface ReleaseBranchPlan {
  /** The release candidate branch, e.g. "release" (small) or "release/1.4.0" (large). */
  branch: string;
  /** Branch the candidate is cut from — for small this is the branch itself. */
  source: string;
  /** True when the branch must be created by prepare_release if missing. */
  createIfMissing: boolean;
  /** True when the branch is thrown away after the release ships. */
  temporary: boolean;
}

export interface SyncTarget {
  branch: string;
  /** Why this branch needs the merge — surfaced in tool output. */
  reason: string;
  /** A missing optional target is skipped rather than reported as a failure. */
  optional: boolean;
}

export interface Strategy {
  readonly name: StrategyName;
  readonly productionBranch: string;
  /** "release" for small, "develop" for large. */
  readonly developmentBranch: string;

  branchPolicy(): BranchPolicy;
  releaseBranchPlan(version: string): ReleaseBranchPlan;

  /** Branches that must receive the production lineage back after a release ships. */
  postReleaseSyncTargets(ctx: StrategyContext, version: string): Promise<SyncTarget[]>;

  /** Always the production lineage — a hotfix never starts from a development branch. */
  hotfixSource(): string;
  /** Branches that must receive a hotfix so the fix isn't lost in the next release. */
  hotfixSyncTargets(ctx: StrategyContext): Promise<SyncTarget[]>;

  /** The release branch that may be deleted after the release ships, or null. */
  releaseBranchCleanup(version: string): string | null;

  /** Strategy-specific readiness checks layered on top of the common ones. */
  extraReleaseChecks(ctx: StrategyContext, version: string, plan: ReleaseBranchPlan): Promise<ValidationCheck[]>;
}
