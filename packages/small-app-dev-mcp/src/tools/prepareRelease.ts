import { Checklist, findOpenPullRequest, getCombinedCiStatus, formatChecklist, isValidSemver } from '@app-dev/git-core';
import type { ProjectContext } from '../context.js';
import { resolveGitHubClient, resolveProject } from '../context.js';

export interface PrepareReleaseOptions {
  version: string;
  dryRun?: boolean;
}

export async function prepareRelease(ctx: ProjectContext, opts: PrepareReleaseOptions): Promise<string> {
  const { config } = ctx;
  const prodBranch = config.workflow.production_branch;
  const devBranch = config.workflow.development_branch;
  const dryRun = opts.dryRun ?? false;

  if (dryRun) {
    return [
      `prepare_release(version: "${opts.version}", dry_run: true)`,
      '',
      'Would check:',
      '1. this is a valid Git repository',
      `2. working tree is clean`,
      `3. "${prodBranch}" branch exists`,
      `4. "${devBranch}" branch exists and has changes`,
      `5. "${prodBranch}" is fully merged into "${devBranch}" (no un-synced hotfix)`,
      '6. current app version is detected',
      '7. target version string is valid semver',
      '8. CI is passing',
      `9. no existing open PR from "${devBranch}" to "${prodBranch}"`,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checklist = new Checklist();

  const isRepo = await ctx.git.isRepo();
  checklist.add('valid_repo', 'this is a valid Git repository', isRepo);
  if (!isRepo) {
    return formatChecklist(`${opts.version} release readiness`, checklist.result());
  }

  const workingTree = await ctx.git.workingTreeStatus();
  checklist.add('clean_worktree', 'clean working tree', workingTree.clean);

  const mainExists = await ctx.git.localBranchExists(prodBranch);
  checklist.add('main_branch_exists', `"${prodBranch}" branch exists`, mainExists);

  const devExists = await ctx.git.localBranchExists(devBranch);
  checklist.add('release_branch_exists', `"${devBranch}" branch exists`, devExists);

  if (devExists) {
    const diff = await ctx.git.aheadBehind(prodBranch, devBranch);
    checklist.add(
      'release_ahead',
      `"${devBranch}" is ahead of "${prodBranch}"`,
      diff.ahead > 0,
      { detail: `${diff.ahead} commit(s) ahead` },
    );
    checklist.add(
      'main_included',
      `latest "${prodBranch}" is included in "${devBranch}"`,
      diff.behind === 0,
      diff.behind === 0 ? {} : { detail: `${devBranch} is missing ${diff.behind} commit(s) from ${prodBranch} — run sync_release` },
    );
  }

  const project = await resolveProject(ctx);
  checklist.add('version_detected', 'current app version is detected', Boolean(project?.version), {
    detail: project?.version ?? 'could not read MARKETING_VERSION — check project.path/scheme in .appdev.yml',
  });

  checklist.add('version_valid', 'target version is valid semver', isValidSemver(opts.version), {
    detail: isValidSemver(opts.version) ? undefined : `"${opts.version}" is not in the form x.y.z`,
  });

  if (ctx.githubToken) {
    try {
      const github = await resolveGitHubClient(ctx);
      const ci = await getCombinedCiStatus(github, devBranch);
      checklist.add('ci_passing', 'CI passing', ci.state === 'success', {
        detail: ci.totalCount === 0 ? 'no CI checks found for this branch' : ci.state,
      });

      const existingPr = await findOpenPullRequest(github, devBranch, prodBranch);
      checklist.add('no_conflicting_pr', 'no existing open release PR', !existingPr, {
        detail: existingPr ? `#${existingPr.number} already open` : undefined,
      });
    } catch (err: any) {
      checklist.add('github_reachable', 'GitHub reachable', false, { detail: err.message });
    }
  } else {
    checklist.add('github_token', 'GITHUB_TOKEN set', false, {
      detail: 'CI and PR checks skipped without a token',
      severity: 'warning',
    });
  }

  const result = checklist.result();
  const summary = formatChecklist(`${opts.version} release readiness`, result);
  return result.ok ? `${summary}\n\nReady to create Release PR.` : summary;
}
