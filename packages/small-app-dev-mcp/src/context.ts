import { GitClient, GitHubClient, parseOwnerRepo, detectProject, type DetectedProject } from '@app-dev/git-core';
import { loadConfig, type AppDevConfig } from './config.js';

export interface ProjectContext {
  cwd: string;
  config: AppDevConfig;
  configFound: boolean;
  git: GitClient;
  githubToken: string | null;
}

export async function buildContext(cwd: string): Promise<ProjectContext> {
  const { config, found } = loadConfig(cwd);
  const git = new GitClient(cwd);
  const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

  return { cwd, config, configFound: found, git, githubToken };
}

/**
 * Resolves project info with .appdev.yml > auto-detection > null priority.
 * `path`/`scheme` in .appdev.yml (if set) are passed straight through to
 * detection as overrides, so bundleId/version/buildNumber are always looked
 * up against whichever project/scheme actually applies.
 */
export async function resolveProject(ctx: ProjectContext): Promise<DetectedProject | null> {
  return detectProject(ctx.cwd, {
    path: ctx.config.project.path,
    scheme: ctx.config.project.scheme,
  });
}

export async function resolveGitHubClient(ctx: ProjectContext): Promise<GitHubClient> {
  if (!ctx.githubToken) {
    throw new Error(
      'GITHUB_TOKEN (or GH_TOKEN) environment variable is not set. Set it to a token with repo scope.',
    );
  }
  const remoteUrl = await ctx.git.remoteUrl();
  if (!remoteUrl) {
    throw new Error('No "origin" remote found in this repository.');
  }
  const ownerRepo = parseOwnerRepo(remoteUrl);
  if (!ownerRepo) {
    throw new Error(`Could not parse a GitHub owner/repo from remote URL: ${remoteUrl}`);
  }
  return new GitHubClient({ ...ownerRepo, token: ctx.githubToken });
}
