import { simpleGit, type SimpleGit } from 'simple-git';
import type { BranchStatus, CommitSummary, WorkingTreeStatus } from './types.js';

export class GitClient {
  private readonly git: SimpleGit;

  constructor(readonly cwd: string) {
    this.git = simpleGit(cwd);
  }

  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo();
  }

  async currentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? '';
  }

  async workingTreeStatus(): Promise<WorkingTreeStatus> {
    const status = await this.git.status();
    return {
      clean: status.isClean(),
      staged: status.staged,
      modified: status.modified,
      notAdded: status.not_added,
      conflicted: status.conflicted,
    };
  }

  async branchStatus(branch?: string): Promise<BranchStatus> {
    const status = await this.git.status();
    return {
      current: branch ?? status.current ?? '',
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
    };
  }

  async localBranchExists(branch: string): Promise<boolean> {
    const branches = await this.git.branchLocal();
    return Object.prototype.hasOwnProperty.call(branches.branches, branch);
  }

  async listLocalBranches(): Promise<string[]> {
    const branches = await this.git.branchLocal();
    return branches.all;
  }

  async listLocalBranchesWithPrefix(prefix: string): Promise<string[]> {
    const all = await this.listLocalBranches();
    return all.filter((b) => b.startsWith(prefix));
  }

  async remoteBranchExists(branch: string, remote = 'origin'): Promise<boolean> {
    const result = await this.git.listRemote(['--heads', remote, branch]);
    return result.trim().length > 0;
  }

  async fetch(remote = 'origin'): Promise<void> {
    await this.git.fetch(remote);
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async createBranch(branch: string, from: string): Promise<void> {
    await this.git.checkoutBranch(branch, from);
  }

  async push(branch: string, remote = 'origin', setUpstream = true): Promise<void> {
    if (setUpstream) {
      await this.git.push(remote, branch, ['--set-upstream']);
    } else {
      await this.git.push(remote, branch);
    }
  }

  /** Ahead/behind count of `branch` relative to `base` (base..branch). */
  async aheadBehind(base: string, branch: string): Promise<{ ahead: number; behind: number }> {
    const ahead = await this.git.raw(['rev-list', '--count', `${base}..${branch}`]);
    const behind = await this.git.raw(['rev-list', '--count', `${branch}..${base}`]);
    return { ahead: parseInt(ahead.trim(), 10) || 0, behind: parseInt(behind.trim(), 10) || 0 };
  }

  /** `git log <range>` wrapper, e.g. range = "main..release". */
  async logRange(range: string): Promise<CommitSummary[]> {
    const raw = await this.git.raw(['log', range, '--pretty=format:%H%x1f%s%x1f%an%x1f%aI']);
    if (!raw.trim()) return [];
    return raw
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, message, authorName, date] = line.split('\x1f');
        return { hash, message, authorName, date };
      });
  }

  async mergeBranch(target: string, source: string): Promise<void> {
    await this.checkout(target);
    await this.git.merge([source]);
  }

  /** Most recent tag reachable from `branch`, or null if there are none. */
  async latestTag(branch: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['describe', '--tags', '--abbrev=0', branch]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async tagExists(tag: string): Promise<boolean> {
    const tags = await this.git.tags();
    return tags.all.includes(tag);
  }

  async createTag(tag: string, message?: string): Promise<void> {
    if (message) {
      await this.git.addAnnotatedTag(tag, message);
    } else {
      await this.git.addTag(tag);
    }
  }

  async pushTag(tag: string, remote = 'origin'): Promise<void> {
    await this.git.raw(['push', remote, tag]);
  }

  async hasRemote(remote = 'origin'): Promise<boolean> {
    const remotes = await this.git.getRemotes();
    return remotes.some((r) => r.name === remote);
  }

  /**
   * Fast-forwards `branch` to match `remote/branch`, never force. If `branch`
   * is not currently checked out this only moves the ref (safe — doesn't
   * touch the working tree); if it is checked out, does a `merge --ff-only`.
   * Never touches history when the branches have diverged.
   */
  async fastForwardBranch(
    branch: string,
    remote = 'origin',
  ): Promise<'updated' | 'up-to-date' | 'diverged' | 'no-remote-branch'> {
    const hasRemote = await this.hasRemote(remote);
    if (!hasRemote) return 'no-remote-branch';

    await this.fetch(remote);
    const remoteRef = `${remote}/${branch}`;
    const remoteExists = await this.git
      .raw(['rev-parse', '--verify', '--quiet', remoteRef])
      .then(() => true)
      .catch(() => false);
    if (!remoteExists) return 'no-remote-branch';

    const localExists = await this.localBranchExists(branch);
    if (!localExists) return 'no-remote-branch';

    const { ahead, behind } = await this.aheadBehind(branch, remoteRef);
    if (behind === 0 && ahead === 0) return 'up-to-date';
    if (behind > 0) return 'diverged';

    const current = await this.currentBranch();
    if (current === branch) {
      await this.git.merge([remoteRef, '--ff-only']);
    } else {
      await this.git.raw(['update-ref', `refs/heads/${branch}`, remoteRef]);
    }
    return 'updated';
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    const remotes = await this.git.getRemotes(true);
    const found = remotes.find((r) => r.name === remote);
    return found?.refs?.fetch ?? null;
  }
}

/** Parses a GitHub `owner/repo` pair out of an https or ssh remote URL. */
export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!httpsMatch) return null;
  return { owner: httpsMatch[1], repo: httpsMatch[2] };
}
