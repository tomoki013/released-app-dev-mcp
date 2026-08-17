import { Checklist, formatChecklist } from '@app-dev/git-core';
import type { ProjectContext } from '../context.js';

export interface StartHotfixOptions {
  name: string;
  version?: string;
  dryRun?: boolean;
}

/** "startup crash" -> "startup-crash"; strips anything that isn't a-z/0-9/hyphen. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function startHotfix(ctx: ProjectContext, opts: StartHotfixOptions): Promise<string> {
  const baseBranch = ctx.config.hotfix.base_branch;
  const slug = slugify(opts.name);
  const branchName = `${ctx.config.workflow.hotfix_prefix}${slug}`;

  if (!slug) {
    return `Could not derive a branch name from "${opts.name}". Use letters, digits, spaces, or hyphens (e.g. "startup crash").`;
  }

  if (opts.dryRun) {
    return [
      `start_hotfix(name: "${opts.name}"${opts.version ? `, version: "${opts.version}"` : ''}, dry_run: true)`,
      '',
      'Would check:',
      '1. working tree is clean',
      `2. "${baseBranch}" branch exists`,
      `3. fast-forward local "${baseBranch}" to match origin (if possible)`,
      `Would create branch "${branchName}" from "${baseBranch}".`,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checklist = new Checklist();
  const workingTree = await ctx.git.workingTreeStatus();
  checklist.add('clean_worktree', 'clean working tree', workingTree.clean);

  const baseExists = await ctx.git.localBranchExists(baseBranch);
  checklist.add('base_branch_exists', `"${baseBranch}" branch exists`, baseExists);

  const result = checklist.result();
  if (!result.ok) {
    return formatChecklist(`start_hotfix(name: "${opts.name}")`, result);
  }

  const alreadyExists = await ctx.git.localBranchExists(branchName);
  if (alreadyExists) {
    await ctx.git.checkout(branchName);
    return `Branch "${branchName}" already exists. Checked it out — continue your fix there.`;
  }

  const ffStatus = await ctx.git.fastForwardBranch(baseBranch).catch(() => 'no-remote-branch' as const);
  const ffNote =
    ffStatus === 'updated'
      ? `(fast-forwarded local "${baseBranch}" to match origin)`
      : ffStatus === 'diverged'
        ? `(local "${baseBranch}" has diverged from origin — branching from local as-is)`
        : '';

  await ctx.git.createBranch(branchName, baseBranch);

  return [
    `Created "${branchName}" from "${baseBranch}"${ffNote ? ` ${ffNote}` : ''}.`,
    '',
    `Commit your fix on this branch, then run finish_hotfix(name: "${opts.name}") to open the PR into "${baseBranch}".`,
  ].join('\n');
}
