import type { GitClient } from '@app-dev/git-core';
import type { SyncTarget } from '../strategies/index.js';

export type MergeOutcome =
  | { kind: 'up-to-date'; target: string; source: string }
  | { kind: 'merged'; target: string; source: string; pushed: boolean; pushError?: string }
  | { kind: 'conflict'; target: string; source: string; files: string[] }
  | { kind: 'skipped'; target: string; source: string; reason: string }
  | { kind: 'failed'; target: string; source: string; error: string };

export interface MergeOptions {
  push?: boolean;
  /** A missing target is reported as skipped instead of failed. */
  optional?: boolean;
  message?: string;
}

/**
 * Merges `source` into `target` without ever leaving the repository in a
 * half-merged state. A conflict is *predicted* first (in memory, no refs
 * touched); if one is found nothing is merged at all, and if a merge somehow
 * fails anyway it is aborted before returning. Conflicts are never resolved
 * automatically — that decision belongs to a human.
 */
export async function safeMerge(
  git: GitClient,
  target: string,
  source: string,
  opts: MergeOptions = {},
): Promise<MergeOutcome> {
  const targetExists = await git.localBranchExists(target);
  if (!targetExists) {
    const reason = `branch "${target}" does not exist locally`;
    return opts.optional
      ? { kind: 'skipped', target, source, reason }
      : { kind: 'failed', target, source, error: reason };
  }

  const tree = await git.workingTreeStatus();
  if (!tree.clean) {
    return { kind: 'failed', target, source, error: 'working tree is not clean — commit or stash first' };
  }

  const preview = await git.previewMerge(target, source);
  if (preview.state === 'up-to-date') return { kind: 'up-to-date', target, source };
  if (preview.state === 'conflict') {
    return { kind: 'conflict', target, source, files: preview.conflictingFiles };
  }

  const originalBranch = await git.currentBranch();
  const message = opts.message ?? `Merge ${source} into ${target}`;
  try {
    await git.mergeBranchNoFf(target, source, message);
  } catch (err: any) {
    const after = await git.workingTreeStatus();
    await git.abortMerge();
    await restoreBranch(git, originalBranch);
    if (after.conflicted.length > 0) {
      return { kind: 'conflict', target, source, files: after.conflicted };
    }
    return { kind: 'failed', target, source, error: err.message };
  }

  // Belt and braces: confirm the merge really landed rather than trusting the
  // command's exit handling, and unwind if it didn't.
  const merged = await git.isAncestor(source, target);
  if (!merged) {
    const after = await git.workingTreeStatus();
    await git.abortMerge();
    await restoreBranch(git, originalBranch);
    return after.conflicted.length > 0
      ? { kind: 'conflict', target, source, files: after.conflicted }
      : { kind: 'failed', target, source, error: `merge of "${source}" into "${target}" did not complete` };
  }

  let pushed = false;
  let pushError: string | undefined;
  if (opts.push && (await git.hasRemote())) {
    try {
      await git.push(target);
      pushed = true;
    } catch (err: any) {
      pushError = err.message;
    }
  }

  await restoreBranch(git, originalBranch);
  return { kind: 'merged', target, source, pushed, pushError };
}

/** Runs `safeMerge` for each target, stopping nothing — every target's outcome is reported. */
export async function syncTargets(
  git: GitClient,
  source: string,
  targets: SyncTarget[],
  opts: { push?: boolean } = {},
): Promise<MergeOutcome[]> {
  const outcomes: MergeOutcome[] = [];
  for (const target of targets) {
    outcomes.push(
      await safeMerge(git, target.branch, source, {
        push: opts.push,
        optional: target.optional,
        message: `Merge ${source} into ${target.branch}`,
      }),
    );
  }
  return outcomes;
}

export function formatMergeOutcome(outcome: MergeOutcome, reason?: string): string {
  const suffix = reason ? ` (${reason})` : '';
  switch (outcome.kind) {
    case 'up-to-date':
      return `✓ "${outcome.target}" already contains "${outcome.source}"${suffix}`;
    case 'merged':
      return outcome.pushed
        ? `✓ merged "${outcome.source}" into "${outcome.target}" and pushed${suffix}`
        : `✓ merged "${outcome.source}" into "${outcome.target}" locally${outcome.pushError ? ` — push failed: ${outcome.pushError}` : ''}${suffix}`;
    case 'conflict':
      return [
        `✗ CONFLICT merging "${outcome.source}" into "${outcome.target}" — nothing was merged`,
        outcome.files.length ? `    conflicting file(s): ${outcome.files.join(', ')}` : '',
        `    resolve manually: git checkout ${outcome.target} && git merge ${outcome.source}`,
      ]
        .filter(Boolean)
        .join('\n');
    case 'skipped':
      return `— skipped "${outcome.target}": ${outcome.reason}`;
    case 'failed':
      return `✗ could not merge into "${outcome.target}": ${outcome.error}`;
  }
}

export function hasBlockingOutcome(outcomes: MergeOutcome[]): boolean {
  return outcomes.some((o) => o.kind === 'conflict' || o.kind === 'failed');
}

async function restoreBranch(git: GitClient, branch: string): Promise<void> {
  if (!branch) return;
  const current = await git.currentBranch();
  if (current !== branch) {
    await git.checkout(branch).catch(() => undefined);
  }
}
