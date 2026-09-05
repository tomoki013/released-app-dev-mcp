import {
  getCombinedCiStatus,
  isValidSemver,
  isVersionGreater,
  tagForVersion,
  versionFromTag,
  highestVersionTag,
  type ValidationCheck,
} from '@app-dev/git-core';
import { resolveGitHubClient, type ProjectContext } from './context.js';

const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i,
  /\.p12$/i,
  /\.mobileprovision$/i,
  /^AuthKey_.+\.p8$/i,
  /(^|\/)GoogleService-Info\.plist$/i,
  /\.keystore$/i,
  /(^|\/)id_rsa$/,
];

export async function cleanWorktreeCheck(ctx: ProjectContext): Promise<ValidationCheck> {
  const tree = await ctx.git.workingTreeStatus();
  return {
    id: 'clean_worktree',
    label: 'clean working tree',
    ok: tree.clean || !ctx.config.release.requireCleanWorktree,
    severity: 'error',
    detail: tree.clean
      ? undefined
      : `${tree.staged.length + tree.modified.length + tree.notAdded.length} uncommitted change(s)`,
  };
}

/** Semver shape, no existing tag (local or remote), and strictly newer than the published version. */
export async function versionChecks(ctx: ProjectContext, version: string): Promise<ValidationCheck[]> {
  const checks: ValidationCheck[] = [];
  const valid = isValidSemver(version);
  checks.push({
    id: 'version_valid',
    label: 'target version is valid semver',
    ok: valid,
    severity: 'error',
    detail: valid ? undefined : `"${version}" is not in the form x.y.z`,
  });
  if (!valid) return checks;

  const tag = tagForVersion(version);
  const [localTag, remoteTag] = await Promise.all([ctx.git.tagExists(tag), ctx.git.remoteTagExists(tag)]);
  checks.push({
    id: 'tag_available',
    label: `production tag "${tag}" is not taken`,
    ok: !localTag && !remoteTag,
    severity: 'error',
    detail:
      localTag || remoteTag
        ? `"${tag}" already exists ${localTag && remoteTag ? 'locally and on origin' : localTag ? 'locally' : 'on origin'} — a published tag is never overwritten`
        : undefined,
  });

  const currentTag = highestVersionTag(await ctx.git.listTags());
  const currentVersion = currentTag ? versionFromTag(currentTag) : null;
  if (currentVersion) {
    checks.push({
      id: 'version_increases',
      label: `version is newer than the published ${currentVersion}`,
      ok: isVersionGreater(version, currentVersion),
      severity: 'error',
      detail: isVersionGreater(version, currentVersion) ? undefined : `published version is ${currentVersion}`,
    });
  }
  return checks;
}

export async function ciCheck(ctx: ProjectContext, branch: string): Promise<ValidationCheck> {
  if (!ctx.config.release.requireCi) {
    return { id: 'ci_passing', label: 'CI passing', ok: true, severity: 'warning', detail: 'CI requirement disabled in config' };
  }
  if (!ctx.githubToken) {
    return {
      id: 'ci_passing',
      label: 'CI passing',
      ok: false,
      severity: 'warning',
      detail: 'GITHUB_TOKEN not set — CI could not be checked',
    };
  }
  try {
    const github = await resolveGitHubClient(ctx);
    const ci = await getCombinedCiStatus(github, branch);
    return {
      id: 'ci_passing',
      label: `CI passing on "${branch}"`,
      ok: ci.state === 'success',
      severity: 'error',
      detail: ci.totalCount === 0 ? 'no CI checks found — push your commits first' : ci.state,
    };
  } catch (err: any) {
    return { id: 'ci_passing', label: 'CI passing', ok: false, severity: 'warning', detail: err.message };
  }
}

/** Flags credentials that look like they were committed in the range being released. */
export async function secretsCheck(ctx: ProjectContext, range: string): Promise<ValidationCheck> {
  let files: string[] = [];
  try {
    const raw = await ctx.git.raw(['diff', '--name-only', range]);
    files = raw.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return { id: 'no_committed_secrets', label: 'no credential files in this release', ok: true, severity: 'warning', detail: 'range could not be diffed' };
  }
  const suspicious = files.filter((f) => SECRET_FILE_PATTERNS.some((p) => p.test(f)));
  return {
    id: 'no_committed_secrets',
    label: 'no credential files in this release',
    ok: suspicious.length === 0,
    severity: 'error',
    detail: suspicious.length ? `looks like a committed secret: ${suspicious.join(', ')}` : undefined,
  };
}

export async function noActiveHotfixCheck(ctx: ProjectContext): Promise<ValidationCheck> {
  const hotfixes = await ctx.git.listLocalBranchesWithPrefix(ctx.config.branches.hotfixPrefix);
  return {
    id: 'no_active_hotfix',
    label: 'no hotfix in progress',
    ok: hotfixes.length === 0,
    severity: 'warning',
    detail: hotfixes.length ? `in progress: ${hotfixes.join(', ')} — finish or land it first` : undefined,
  };
}
