import {
  findOpenPullRequest,
  getCombinedCiStatus,
  highestVersionTag,
  parseOwnerRepo,
  versionFromTag,
  type DetectedProject,
  type WorkingTreeStatus,
} from '@app-dev/git-core';
import { activeReleaseBranches } from '../strategies/index.js';
import { CONFIG_FILENAME } from './config.js';
import { resolveGitHubClient, resolveProject, type ProjectContext } from './context.js';
import { loadState, type ReleaseState } from './state.js';

export interface BranchDivergence {
  branch: string;
  exists: boolean;
  ahead: number;
  behind: number;
}

export interface RepoStatus {
  isRepo: boolean;
  managed: boolean;
  lifecycle: string;
  strategy: string;
  ownerRepo: { owner: string; repo: string } | null;
  currentBranch: string;
  workingTree: WorkingTreeStatus | null;
  project: DetectedProject | null;
  productionTag: string | null;
  productionVersion: string | null;
  divergence: BranchDivergence[];
  activeReleaseBranches: string[];
  activeHotfixBranches: string[];
  releaseState: ReleaseState;
  ci: { branch: string; state: string; totalCount: number } | null;
  openReleasePr: string | null;
  githubError: string | null;
  blockingIssues: string[];
  nextAction: string;
}

export async function collectStatus(ctx: ProjectContext): Promise<RepoStatus> {
  const strategy = ctx.strategy;
  const production = strategy.productionBranch;
  const development = strategy.developmentBranch;

  const base: RepoStatus = {
    isRepo: false,
    managed: ctx.configFound && !ctx.configFromLegacy,
    lifecycle: ctx.config.lifecycle,
    strategy: strategy.name,
    ownerRepo: null,
    currentBranch: '',
    workingTree: null,
    project: null,
    productionTag: null,
    productionVersion: null,
    divergence: [],
    activeReleaseBranches: [],
    activeHotfixBranches: [],
    releaseState: loadState(ctx.cwd),
    ci: null,
    openReleasePr: null,
    githubError: null,
    blockingIssues: [],
    nextAction: '',
  };

  if (!(await ctx.git.isRepo())) {
    base.blockingIssues.push('This directory is not a Git repository.');
    base.nextAction = 'Run `git init` (or open the app repository) first.';
    return base;
  }
  base.isRepo = true;

  const [currentBranch, workingTree, remoteUrl, project, tags] = await Promise.all([
    ctx.git.currentBranch(),
    ctx.git.workingTreeStatus(),
    ctx.git.remoteUrl(),
    resolveProject(ctx),
    ctx.git.listTags(),
  ]);

  base.currentBranch = currentBranch;
  base.workingTree = workingTree;
  base.project = project;
  base.ownerRepo = remoteUrl ? parseOwnerRepo(remoteUrl) : null;
  base.productionTag = highestVersionTag(tags);
  base.productionVersion = base.productionTag ? versionFromTag(base.productionTag) : null;

  for (const branch of [production, development]) {
    const exists = await ctx.git.localBranchExists(branch);
    if (!exists) {
      base.divergence.push({ branch, exists: false, ahead: 0, behind: 0 });
      continue;
    }
    const diff = branch === production ? { ahead: 0, behind: 0 } : await ctx.git.aheadBehind(production, branch);
    base.divergence.push({ branch, exists: true, ...diff });
  }

  base.activeReleaseBranches = (
    await activeReleaseBranches(ctx, ctx.config.branches.releasePrefix)
  ).filter((b) => b !== development);
  base.activeHotfixBranches = [
    ...new Set([
      ...(await ctx.git.listLocalBranchesWithPrefix(ctx.config.branches.hotfixPrefix)),
      ...(await ctx.git.listRemoteBranchesWithPrefix(ctx.config.branches.hotfixPrefix).catch(() => [])),
    ]),
  ].sort();

  if (ctx.githubToken) {
    try {
      const github = await resolveGitHubClient(ctx);
      const ciBranch = base.activeReleaseBranches[0] ?? development;
      const ci = await getCombinedCiStatus(github, ciBranch);
      base.ci = { branch: ciBranch, state: ci.totalCount === 0 ? 'no checks found' : ci.state, totalCount: ci.totalCount };
      const pr = await findOpenPullRequest(github, ciBranch, production);
      base.openReleasePr = pr ? `#${pr.number} ${pr.url}` : null;
    } catch (err: any) {
      base.githubError = err.message;
    }
  }

  computeIssuesAndNextAction(ctx, base);
  return base;
}

function computeIssuesAndNextAction(ctx: ProjectContext, status: RepoStatus): void {
  const strategy = ctx.strategy;
  const production = strategy.productionBranch;
  const development = strategy.developmentBranch;

  if (!status.managed) {
    status.blockingIssues.push(
      ctx.configFromLegacy
        ? `Legacy .appdev.yml only — no ${CONFIG_FILENAME}, so the strategy is not pinned.`
        : `No ${CONFIG_FILENAME} — this is an unmanaged repository.`,
    );
  }
  for (const error of ctx.configErrors) status.blockingIssues.push(error);

  for (const entry of status.divergence) {
    if (!entry.exists) status.blockingIssues.push(`Branch "${entry.branch}" does not exist locally.`);
  }

  const devDivergence = status.divergence.find((d) => d.branch === development);
  if (devDivergence?.exists && devDivergence.behind > 0) {
    status.blockingIssues.push(
      `"${development}" is missing ${devDivergence.behind} commit(s) from "${production}" — run sync_release.`,
    );
  }

  if (status.lifecycle === 'released' && !status.productionTag) {
    status.blockingIssues.push(
      'No vX.Y.Z production tag found — the published App Store version is not tracked in Git yet.',
    );
  }

  if (status.workingTree && !status.workingTree.clean) {
    status.blockingIssues.push('Working tree is dirty — release and hotfix tools require a clean tree.');
  }

  status.nextAction = pickNextAction(ctx, status);
}

function pickNextAction(ctx: ProjectContext, status: RepoStatus): string {
  if (!status.managed) return 'Run setup_repository to register this released app with the MCP.';
  const missing = status.divergence.find((d) => !d.exists);
  if (missing) return `Run setup_repository — "${missing.branch}" is missing.`;
  if (status.activeHotfixBranches.length > 0) {
    return `Finish the hotfix in progress: finish_hotfix(name: "${status.activeHotfixBranches[0].replace(ctx.config.branches.hotfixPrefix, '')}")`;
  }
  if (status.activeReleaseBranches.length > 0) {
    return `A release candidate is in flight (${status.activeReleaseBranches.join(', ')}) — create_release_pr, then finish_release once it is live on the App Store.`;
  }
  const dev = status.divergence.find((d) => d.branch === ctx.strategy.developmentBranch);
  if (dev?.exists && dev.behind > 0) return 'Run sync_release — the development branch is behind production.';
  if (dev?.exists && dev.ahead > 0) return 'Run prepare_release(version) when you are ready to ship.';
  return 'Nothing pending — develop on feature/* branches into the development branch.';
}
