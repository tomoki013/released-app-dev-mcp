import { execFileSync } from 'node:child_process';
import { GitClient, GitHubClient, parseOwnerRepo, detectProject, type DetectedProject } from '@app-dev/git-core';
import { createStrategy, type Strategy } from '../strategies/index.js';
import { CONFIG_FILENAME, loadConfig, type AppDevConfig } from './config.js';

export interface ProjectContext {
  cwd: string;
  config: AppDevConfig;
  configFound: boolean;
  configPath: string;
  configFromLegacy: boolean;
  configErrors: string[];
  strategy: Strategy;
  git: GitClient;
  githubToken: string | null;
}

export interface BuildContextOptions {
  /** Explicit token; `null` disables GitHub entirely (tests, offline use). Omit to resolve from the environment. */
  githubToken?: string | null;
}

export const GITHUB_TOKEN_HINT = 'set GITHUB_TOKEN (repo scope) or sign in with `gh auth login`';

export async function buildContext(cwd: string, opts: BuildContextOptions = {}): Promise<ProjectContext> {
  const { config, found, path, fromLegacy, errors } = loadConfig(cwd);
  return {
    cwd,
    config,
    configFound: found,
    configPath: path,
    configFromLegacy: fromLegacy,
    configErrors: errors,
    strategy: createStrategy(config),
    git: new GitClient(cwd),
    githubToken: opts.githubToken !== undefined ? opts.githubToken : resolveGitHubToken(),
  };
}

/** GITHUB_TOKEN / GH_TOKEN first; otherwise whatever `gh` is already signed in with. */
export function resolveGitHubToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Every release/hotfix tool refuses to act on a repository that hasn't been
 * registered: without a committed strategy we'd be guessing at the branch
 * model of a shipped app, which is precisely the guessing this MCP removes.
 */
export function requireManaged(ctx: ProjectContext): string | null {
  if (ctx.configFound && !ctx.configFromLegacy) return null;
  const reason = ctx.configFromLegacy
    ? `This repository still uses the legacy .appdev.yml and has no ${CONFIG_FILENAME}.`
    : `This repository has no ${CONFIG_FILENAME} — it is an unmanaged released app.`;
  return [
    reason,
    '',
    'Run setup_repository first so the Git strategy (small or large) is recorded in the repository',
    'instead of being guessed per session.',
  ].join('\n');
}

/**
 * Resolves project info with config > auto-detection > null priority.
 * `path`/`scheme` from the config (if set) are passed straight through to
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
    throw new Error(`No GitHub credentials found — ${GITHUB_TOKEN_HINT}.`);
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
