import type { ProjectContext } from '../context.js';

export interface SyncReleaseOptions {
  dryRun?: boolean;
}

export async function syncRelease(ctx: ProjectContext, opts: SyncReleaseOptions = {}): Promise<string> {
  const prodBranch = ctx.config.workflow.production_branch;
  const devBranch = ctx.config.workflow.development_branch;

  const isRepo = await ctx.git.isRepo();
  if (!isRepo) {
    return 'This directory is not a Git repository.';
  }

  const [mainExists, devExists] = await Promise.all([
    ctx.git.localBranchExists(prodBranch),
    ctx.git.localBranchExists(devBranch),
  ]);
  if (!mainExists) return `Branch "${prodBranch}" does not exist locally.`;
  if (!devExists) return `Branch "${devBranch}" does not exist locally.`;

  const diff = await ctx.git.aheadBehind(devBranch, prodBranch);
  if (diff.ahead === 0) {
    return `"${devBranch}" already contains all commits from "${prodBranch}". Nothing to sync.`;
  }

  if (opts.dryRun) {
    return [
      `sync_release(dry_run: true)`,
      '',
      `Would merge "${prodBranch}" into "${devBranch}" (${diff.ahead} commit(s) to bring in).`,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const workingTree = await ctx.git.workingTreeStatus();
  if (!workingTree.clean) {
    return 'Working tree is not clean. Commit or stash your changes before syncing.';
  }

  try {
    await ctx.git.mergeBranch(devBranch, prodBranch);
  } catch (err: any) {
    const afterMerge = await ctx.git.workingTreeStatus();
    if (afterMerge.conflicted.length > 0) {
      return [
        'Merge conflict detected. Manual resolution required.',
        '',
        `Conflicted file(s): ${afterMerge.conflicted.join(', ')}`,
        `Resolve on "${devBranch}", then: git add <files> && git commit`,
      ].join('\n');
    }
    return [
      `Merge of "${prodBranch}" into "${devBranch}" failed.`,
      `Resolve it manually: git checkout ${devBranch} && git merge ${prodBranch}`,
      '',
      `Details: ${err.message}`,
    ].join('\n');
  }

  try {
    await ctx.git.push(devBranch);
  } catch (err: any) {
    return [
      `Merged "${prodBranch}" into "${devBranch}" locally, but pushing failed.`,
      `Push it manually: git push origin ${devBranch}`,
      '',
      `Details: ${err.message}`,
    ].join('\n');
  }

  return `Synced "${prodBranch}" into "${devBranch}" (${diff.ahead} commit(s)) and pushed.`;
}
