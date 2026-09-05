import { formatChecklist, isValidSemver, type ValidationCheck } from '@app-dev/git-core';
import { requireManaged, type ProjectContext } from '../core/context.js';

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
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A hotfix branch is named after its version when one is known, else after the issue. */
export function hotfixBranchName(ctx: ProjectContext, opts: { name?: string; version?: string }): string {
  const prefix = ctx.config.branches.hotfixPrefix;
  if (opts.version && isValidSemver(opts.version)) return `${prefix}${opts.version}`;
  return `${prefix}${slugify(opts.name ?? '')}`;
}

/**
 * Finds the branch a `finish_hotfix` call refers to, tolerating the two naming
 * shapes (`hotfix/1.2.1` and `hotfix/startup-crash`) plus a bare name.
 */
export async function resolveHotfixBranch(
  ctx: ProjectContext,
  opts: { name?: string; version?: string },
): Promise<string | null> {
  const candidates = [
    opts.version ? `${ctx.config.branches.hotfixPrefix}${opts.version}` : null,
    opts.name ? `${ctx.config.branches.hotfixPrefix}${slugify(opts.name)}` : null,
    opts.name && opts.name.startsWith(ctx.config.branches.hotfixPrefix) ? opts.name : null,
  ].filter((b): b is string => Boolean(b));

  for (const candidate of candidates) {
    if (await ctx.git.localBranchExists(candidate)) return candidate;
  }
  return null;
}

/** Hotfixes always branch from the production lineage — never from a development branch. */
export async function startHotfix(ctx: ProjectContext, opts: StartHotfixOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  const source = ctx.strategy.hotfixSource();
  const branchName = hotfixBranchName(ctx, opts);

  if (branchName === ctx.config.branches.hotfixPrefix) {
    return `Could not derive a branch name from "${opts.name}". Use letters, digits, spaces or hyphens (e.g. "startup crash"), or pass a version.`;
  }
  if (opts.version && !isValidSemver(opts.version)) {
    return `"${opts.version}" is not a valid version (expected x.y.z).`;
  }

  if (opts.dryRun) {
    return [
      `start_hotfix(name: "${opts.name}"${opts.version ? `, version: "${opts.version}"` : ''}, dry_run: true)  [strategy: ${ctx.strategy.name}]`,
      '',
      'Would check:',
      '  1. working tree is clean',
      `  2. "${source}" (production lineage) exists`,
      `  3. fast-forward local "${source}" to match origin, if it can be done without force`,
      `Would create branch "${branchName}" from "${source}".`,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const checks: ValidationCheck[] = [];
  const tree = await ctx.git.workingTreeStatus();
  checks.push({ id: 'clean_worktree', label: 'clean working tree', ok: tree.clean, severity: 'error' });

  const sourceExists = await ctx.git.localBranchExists(source);
  checks.push({
    id: 'source_exists',
    label: `"${source}" branch exists`,
    ok: sourceExists,
    severity: 'error',
    detail: sourceExists ? undefined : 'a hotfix must start from the production lineage',
  });

  const result = { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks };
  if (!result.ok) return formatChecklist(`start_hotfix("${opts.name}")`, result);

  if (await ctx.git.localBranchExists(branchName)) {
    await ctx.git.checkout(branchName);
    return `Branch "${branchName}" already exists. Checked it out — continue your fix there.`;
  }

  const ffStatus = await ctx.git.fastForwardBranch(source).catch(() => 'no-remote-branch' as const);
  const ffNote =
    ffStatus === 'updated'
      ? ` (fast-forwarded local "${source}" to match origin)`
      : ffStatus === 'diverged'
        ? ` (local "${source}" has diverged from origin — branching from local as-is)`
        : '';

  await ctx.git.createBranch(branchName, source);

  return [
    `Created "${branchName}" from "${source}"${ffNote}.`,
    '',
    'Commit the fix on this branch, then run',
    `  finish_hotfix(name: "${opts.name}"${opts.version ? `, version: "${opts.version}"` : ', version: "x.y.z"'})`,
    `to land it on "${source}", tag the published version, and sync it into the development line.`,
  ].join('\n');
}
