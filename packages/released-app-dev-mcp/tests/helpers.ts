import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, type ProjectContext } from '../src/core/context.js';
import { defaultConfig, saveConfig, type StrategyName } from '../src/core/config.js';

// Tests must never reach GitHub: every tool degrades to local-only Git when
// there is no token, which is also the path an offline developer takes.
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

export interface TestRepoOptions {
  /** Writes .app-dev-mcp.json up front, i.e. an already-registered repository. */
  strategy?: StrategyName;
  /** Adds an App.xcodeproj + project overrides so workflow generation runs. */
  withProject?: boolean;
}

/** A repository with a single commit on `main`, isolated in a temp directory. */
export function createTestRepo(opts: TestRepoOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'released-app-mcp-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# Test app\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: initial commit');

  if (opts.withProject) {
    mkdirSync(join(dir, 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(dir, 'App.xcodeproj', 'project.pbxproj'), '// stub\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'chore: add project stub');
  }

  if (opts.strategy) {
    const config = defaultConfig(opts.strategy);
    if (opts.withProject) config.project = { path: 'App.xcodeproj', scheme: 'App' };
    saveConfig(dir, config);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'chore: register with released-app-dev-mcp');
  }

  return dir;
}

export async function ctxFor(dir: string): Promise<ProjectContext> {
  return buildContext(dir);
}

/** Commits `content` to `file` on `branch`, returning to the previous branch afterwards. */
export function commitOn(dir: string, branch: string, file: string, content: string, message: string): void {
  const previous = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const exists = git(dir, 'branch', '--list', branch).length > 0;
  git(dir, 'checkout', exists ? branch : '-b', ...(exists ? [] : [branch]));
  writeFileSync(join(dir, file), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', message);
  if (previous !== branch) git(dir, 'checkout', previous);
}

/** Commits whatever the tools just generated — the user's job in real use. */
export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

export function currentBranch(dir: string): string {
  return git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
}

export function branchExists(dir: string, branch: string): boolean {
  return git(dir, 'branch', '--list', branch).length > 0;
}

export function tags(dir: string): string[] {
  const out = git(dir, 'tag', '--list');
  return out ? out.split('\n').map((t) => t.trim()) : [];
}

/** True when `commit-ish` is contained in `branch`'s history. */
export function isMergedInto(dir: string, commitish: string, branch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commitish, branch], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export function fileOnBranch(dir: string, branch: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${branch}:${file}`], { cwd: dir, encoding: 'utf-8' });
  } catch {
    return null;
  }
}
