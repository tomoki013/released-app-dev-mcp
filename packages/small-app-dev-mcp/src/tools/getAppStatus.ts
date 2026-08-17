import { findOpenPullRequest, getCombinedCiStatus, parseOwnerRepo } from '@app-dev/git-core';
import type { ProjectContext } from '../context.js';
import { resolveGitHubClient, resolveProject } from '../context.js';

export async function getAppStatus(ctx: ProjectContext): Promise<string> {
  const { config } = ctx;
  const prodBranch = config.workflow.production_branch;
  const devBranch = config.workflow.development_branch;

  const isRepo = await ctx.git.isRepo();
  if (!isRepo) {
    return 'This directory is not a Git repository.';
  }

  const [currentBranch, workingTree, remoteUrl, project] = await Promise.all([
    ctx.git.currentBranch(),
    ctx.git.workingTreeStatus(),
    ctx.git.remoteUrl(),
    resolveProject(ctx),
  ]);
  const ownerRepo = remoteUrl ? parseOwnerRepo(remoteUrl) : null;

  const sections: string[] = [];
  sections.push(ownerRepo?.repo ?? '(no origin remote)');

  const projectLines = ['Project'];
  if (project) {
    projectLines.push(`  iOS — ${project.projectPath}`);
    projectLines.push(`  Scheme: ${project.scheme ?? 'not detected'}`);
  } else {
    projectLines.push('  No Xcode project detected in this directory.');
  }
  sections.push(projectLines.join('\n'));

  const treeLine = workingTree.clean
    ? 'clean'
    : `dirty (${workingTree.staged.length + workingTree.modified.length + workingTree.notAdded.length} changed file(s))`;
  sections.push(['Git', `  Current branch: ${currentBranch}`, `  Working tree: ${treeLine}`].join('\n'));

  const devExists = await ctx.git.localBranchExists(devBranch);
  const branchLines = ['Branches'];
  const mainTag = await ctx.git.latestTag(prodBranch).catch(() => null);
  branchLines.push(`  ${prodBranch}: ${mainTag ?? 'no tag'}`);

  let releaseMissingMain = false;
  if (devExists) {
    const diff = await ctx.git.aheadBehind(prodBranch, devBranch);
    releaseMissingMain = diff.behind > 0;
    const behindNote = diff.behind > 0 ? `, ${diff.behind} behind` : '';
    branchLines.push(`  ${devBranch}: ${diff.ahead} commit(s) ahead of ${prodBranch}${behindNote}`);
  } else {
    branchLines.push(`  ${devBranch}: branch not found locally`);
  }
  sections.push(branchLines.join('\n'));

  const hotfixBranches = await ctx.git.listLocalBranchesWithPrefix(config.workflow.hotfix_prefix);

  const githubToken = ctx.githubToken;
  let releasePrLine = 'Open release PR: unknown (GITHUB_TOKEN not configured)';
  let ciLines = ['GitHub', '  Unavailable (GITHUB_TOKEN not configured)'];
  const hotfixPrLines: string[] = [];

  if (githubToken) {
    try {
      const github = await resolveGitHubClient(ctx);
      const releasePr = await findOpenPullRequest(github, devBranch, prodBranch);
      releasePrLine = `Open release PR: ${releasePr ? `#${releasePr.number} ${releasePr.url}` : 'none'}`;

      const ci = await getCombinedCiStatus(github, devBranch);
      ciLines = ['GitHub', `  CI (${devBranch}): ${ci.totalCount ? ci.state : 'no checks found'}`];

      for (const hotfixBranch of hotfixBranches) {
        const hotfixPr = await findOpenPullRequest(github, hotfixBranch, prodBranch);
        hotfixPrLines.push(`  ${hotfixBranch} PR: ${hotfixPr ? `#${hotfixPr.number} ${hotfixPr.url}` : 'not yet opened'}`);
      }
    } catch (err: any) {
      ciLines = ['GitHub', `  Error fetching status — ${err.message}`];
    }
  }

  sections.push(['Release', `  ${releasePrLine}`].join('\n'));

  const hotfixLines = ['Hotfix'];
  if (hotfixBranches.length === 0) {
    hotfixLines.push('  none');
  } else {
    hotfixLines.push(...hotfixBranches.map((b) => `  ${b}`), ...hotfixPrLines);
  }
  if (releaseMissingMain) {
    hotfixLines.push(
      `  ⚠ ${devBranch} is missing changes currently in ${prodBranch}.`,
      '    Run: sync_release',
    );
  }
  sections.push(hotfixLines.join('\n'));

  sections.push(ciLines.join('\n'));

  const versionLines = ['Version'];
  if (project?.version) {
    versionLines.push(`  ${project.version}${project.buildNumber ? ` (build ${project.buildNumber})` : ''}`);
  } else {
    versionLines.push('  not detected');
  }
  sections.push(versionLines.join('\n'));

  return sections.join('\n\n');
}
