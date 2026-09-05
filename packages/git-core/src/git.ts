import { execFile } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { BranchStatus, CommitSummary, MergePreview, WorkingTreeStatus } from './types.js';

export class GitClient {
  private readonly git: SimpleGit;

  constructor(readonly cwd: string) {
    this.git = simpleGit(cwd);
  }

  /** Escape hatch for callers that need a plumbing command this class doesn't wrap. */
  async raw(args: string[]): Promise<string> {
    return this.git.raw(args);
  }

  /**
   * Runs git and hands back the exit code instead of throwing. Needed for the
   * commands whose *exit code* is the answer (`merge-tree` returns 1 for
   * "conflicts"), which a throw-on-failure wrapper can't distinguish from a
   * command that simply failed.
   */
  private runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
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

  /** Remote-tracking branches (without the `origin/` prefix) matching `prefix`. */
  async listRemoteBranchesWithPrefix(prefix: string, remote = 'origin'): Promise<string[]> {
    let raw: string;
    try {
      raw = await this.git.raw(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]);
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((ref) => ref.slice(`${remote}/`.length))
      .filter((branch) => branch !== 'HEAD' && branch.startsWith(prefix));
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

  /**
   * Deletes a local branch with `-d` (refuses when the branch isn't merged).
   * Never uses `-D`: losing unmerged commits is exactly what this MCP exists
   * to prevent, so an unmerged branch surfaces as an error for the caller to
   * report instead of a silent deletion.
   */
  async deleteLocalBranch(branch: string): Promise<void> {
    await this.git.raw(['branch', '-d', branch]);
  }

  async deleteRemoteBranch(branch: string, remote = 'origin'): Promise<void> {
    await this.git.raw(['push', remote, '--delete', branch]);
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

  /** Full SHA for any revision, or null when the revision doesn't resolve. */
  async revParse(rev: string): Promise<string | null> {
    try {
      const out = await this.git.raw(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async currentCommit(): Promise<string | null> {
    return this.revParse('HEAD');
  }

  /** True when `ancestor` is contained in `descendant`'s history (i.e. already merged). */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const [a, d] = await Promise.all([this.revParse(ancestor), this.revParse(descendant)]);
    if (!a || !d) return false;
    if (a === d) return true;
    // Commits reachable from `a` but not from `d`; none means `a` is contained in `d`.
    const { code, stdout } = await this.runGit(['rev-list', '--count', `${d}..${a}`]);
    if (code !== 0) return false;
    return parseInt(stdout.trim(), 10) === 0;
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

  /** Merge that always records a merge commit, so release/hotfix merges stay visible in history. */
  async mergeBranchNoFf(target: string, source: string, message: string): Promise<void> {
    await this.checkout(target);
    await this.git.raw(['merge', '--no-ff', '-m', message, source]);
  }

  async abortMerge(): Promise<void> {
    await this.git.raw(['merge', '--abort']).catch(() => undefined);
  }

  /**
   * Answers "would merging `source` into `target` conflict?" WITHOUT touching
   * the working tree or any ref — `merge-tree --write-tree` merges in memory.
   * Returns 'unknown' on older Git, so callers must treat that as "not proven
   * safe" rather than as a green light.
   */
  async previewMerge(target: string, source: string): Promise<MergePreview> {
    const targetSha = await this.revParse(target);
    const sourceSha = await this.revParse(source);
    if (!targetSha || !sourceSha) return { state: 'unknown', conflictingFiles: [] };

    if (await this.isAncestor(sourceSha, targetSha)) {
      return { state: 'up-to-date', conflictingFiles: [] };
    }

    const { code, stdout } = await this.runGit(['merge-tree', '--write-tree', '--name-only', targetSha, sourceSha]);
    if (code === 0) return { state: 'clean', conflictingFiles: [] };
    // 1 = merged with conflicts. Anything else (unsupported flag on old Git,
    // a bad revision) is "we don't know" — never a green light.
    if (code !== 1) return { state: 'unknown', conflictingFiles: [] };
    return { state: 'conflict', conflictingFiles: parseMergeTreeConflicts(stdout) };
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

  async listTags(): Promise<string[]> {
    const tags = await this.git.tags();
    return tags.all;
  }

  async tagExists(tag: string): Promise<boolean> {
    const tags = await this.git.tags();
    return tags.all.includes(tag);
  }

  async remoteTagExists(tag: string, remote = 'origin'): Promise<boolean> {
    try {
      const out = await this.git.listRemote(['--tags', remote, `refs/tags/${tag}`]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Commit a tag points at (dereferencing annotated tags), or null. */
  async tagCommit(tag: string): Promise<string | null> {
    return this.revParse(tag);
  }

  async createTag(tag: string, message?: string, commit?: string): Promise<void> {
    if (message) {
      const args = ['tag', '-a', tag, '-m', message];
      if (commit) args.push(commit);
      await this.git.raw(args);
    } else {
      await this.git.raw(commit ? ['tag', tag, commit] : ['tag', tag]);
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

/**
 * `merge-tree --write-tree --name-only` prints the resulting tree OID on the
 * first line, then the conflicted paths, then a blank line and the human-readable
 * conflict messages.
 */
function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split('\n').map((l) => l.trim());
  const files: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line) break;
    files.push(line);
  }
  return files;
}

/** Parses a GitHub `owner/repo` pair out of an https or ssh remote URL. */
export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!httpsMatch) return null;
  return { owner: httpsMatch[1], repo: httpsMatch[2] };
}
