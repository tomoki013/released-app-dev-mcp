import { Octokit } from '@octokit/rest';
import type { GitHubContext } from './types.js';

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export class GitHubClient {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(ctx: GitHubContext) {
    this.octokit = createOctokit(ctx.token);
    this.owner = ctx.owner;
    this.repo = ctx.repo;
  }

  async repoExists(): Promise<boolean> {
    try {
      await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
      return true;
    } catch (err: any) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async getDefaultBranch(): Promise<string> {
    const { data } = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    return data.default_branch;
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.octokit.repos.getBranch({ owner: this.owner, repo: this.repo, branch });
      return true;
    } catch (err: any) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  /** True if branch protection already blocks force-push/deletion and requires a PR — used to make setup_repository idempotent. */
  async isBranchProtectionConfigured(branch: string): Promise<boolean> {
    try {
      const { data } = await this.octokit.repos.getBranchProtection({ owner: this.owner, repo: this.repo, branch });
      return Boolean(
        data.required_pull_request_reviews &&
          data.required_status_checks &&
          data.allow_force_pushes?.enabled === false &&
          data.allow_deletions?.enabled === false,
      );
    } catch (err: any) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Requires a PR before merging (no direct push) without requiring anyone
   * else's approval — small/solo teams don't have a second reviewer on hand.
   * "Require a PR" and "require review" are separate GitHub settings:
   * required_approving_review_count: 0 keeps the PR requirement while
   * dropping the review requirement.
   */
  async updateBranchProtection(branch: string, requiredChecks: string[] = []): Promise<void> {
    await this.octokit.repos.updateBranchProtection({
      owner: this.owner,
      repo: this.repo,
      branch,
      required_status_checks: { strict: true, contexts: requiredChecks },
      enforce_admins: false,
      required_pull_request_reviews: {
        required_approving_review_count: 0,
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  }
}
