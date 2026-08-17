import { Checklist, createPullRequest, findOpenPullRequest, formatChecklist, getCombinedCiStatus } from '@app-dev/git-core';
import type { ProjectContext } from '../context.js';
import { resolveGitHubClient } from '../context.js';
import { slugify } from './startHotfix.js';

export interface FinishHotfixOptions {
  name: string;
  dryRun?: boolean;
}

export async function finishHotfix(ctx: ProjectContext, opts: FinishHotfixOptions): Promise<string> {
  const baseBranch = ctx.config.hotfix.base_branch;
  const slug = slugify(opts.name);
  const branchName = `${ctx.config.workflow.hotfix_prefix}${slug}`;
  const title = `Hotfix: ${slug}`;

  const branchExists = await ctx.git.localBranchExists(branchName);
  if (!branchExists) {
    return `Branch "${branchName}" does not exist locally. Run start_hotfix first.`;
  }

  if (opts.dryRun) {
    return [
      `finish_hotfix(name: "${opts.name}", dry_run: true)`,
      '',
      'Would check:',
      `1. currently on (or can switch to) "${branchName}"`,
      '2. working tree is clean',
      '3. CI is passing on the hotfix branch',
      `Would open PR: "${title}" (${branchName} -> ${baseBranch})`,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checklist = new Checklist();

  const currentBranch = await ctx.git.currentBranch();
  if (currentBranch !== branchName) {
    try {
      await ctx.git.checkout(branchName);
      checklist.add('on_hotfix_branch', `on "${branchName}"`, true, { detail: `switched from "${currentBranch}"` });
    } catch (err: any) {
      checklist.add('on_hotfix_branch', `on "${branchName}"`, false, { detail: err.message });
      return formatChecklist(`${branchName} readiness`, checklist.result());
    }
  } else {
    checklist.add('on_hotfix_branch', `on "${branchName}"`, true);
  }

  const workingTree = await ctx.git.workingTreeStatus();
  checklist.add('clean_worktree', 'clean working tree', workingTree.clean);

  if (!ctx.githubToken) {
    checklist.add('github_token', 'GITHUB_TOKEN set', false, {
      detail: 'cannot verify CI or open a PR without a token',
    });
    return formatChecklist(`${branchName} readiness`, checklist.result());
  }

  const github = await resolveGitHubClient(ctx);
  const ci = await getCombinedCiStatus(github, branchName);
  checklist.add('ci_passing', 'CI passing', ci.state === 'success', {
    detail: ci.totalCount === 0 ? 'no CI checks found for this branch — push your commits first' : ci.state,
  });

  const result = checklist.result();
  if (!result.ok) {
    return formatChecklist(`${branchName} readiness`, result);
  }

  const existing = await findOpenPullRequest(github, branchName, baseBranch);
  if (existing) {
    return `Hotfix PR already open: #${existing.number} ${existing.url}`;
  }

  const commits = await ctx.git.logRange(`${baseBranch}..${branchName}`);
  const body = [
    `## Hotfix: ${slug}`,
    '',
    '### Commits',
    ...commits.map((c) => `- ${c.message.split('\n')[0]}`),
    '',
    `After this merges, remember to run sync_release so "${ctx.config.workflow.development_branch}" picks up this fix.`,
  ].join('\n');

  const pr = await createPullRequest(github, { head: branchName, base: baseBranch, title, body });
  return `Created hotfix PR #${pr.number}: ${pr.url}`;
}
