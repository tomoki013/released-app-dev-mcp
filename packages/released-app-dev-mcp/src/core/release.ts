import { tagForVersion } from '@app-dev/git-core';
import type { ProjectContext } from './context.js';
import { safeMerge, type MergeOutcome } from './merge.js';

/**
 * Brings `sourceBranch` into the production lineage. When the PR has already
 * been merged this is a no-op — finish_release must work equally well whether
 * the merge happened on GitHub or here.
 */
export async function mergeIntoProduction(
  ctx: ProjectContext,
  sourceBranch: string,
): Promise<{ alreadyMerged: boolean; outcome: MergeOutcome | null }> {
  const production = ctx.strategy.productionBranch;
  const sourceSha = await ctx.git.revParse(sourceBranch);
  if (sourceSha && (await ctx.git.isAncestor(sourceSha, production))) {
    return { alreadyMerged: true, outcome: null };
  }
  const outcome = await safeMerge(ctx.git, production, sourceBranch, {
    push: true,
    message: `Merge ${sourceBranch} into ${production}`,
  });
  return { alreadyMerged: false, outcome };
}

export interface TagResult {
  tag: string;
  created: boolean;
  pushed: boolean;
  commit: string | null;
  error?: string;
}

/**
 * Creates the published-version tag. A tag that already exists is NEVER moved
 * or overwritten — published tags are the record of what shipped.
 */
export async function createProductionTag(
  ctx: ProjectContext,
  version: string,
  message: string,
  commit?: string,
): Promise<TagResult> {
  const tag = tagForVersion(version);
  const target = commit ?? (await ctx.git.revParse(ctx.strategy.productionBranch));

  if (await ctx.git.tagExists(tag)) {
    const existing = await ctx.git.tagCommit(tag);
    return {
      tag,
      created: false,
      pushed: false,
      commit: existing,
      error:
        existing === target
          ? undefined
          : `tag "${tag}" already exists at ${existing?.slice(0, 7)} — refusing to overwrite a published tag`,
    };
  }

  await ctx.git.createTag(tag, message, target ?? undefined);
  let pushed = false;
  let error: string | undefined;
  if (await ctx.git.hasRemote()) {
    try {
      await ctx.git.pushTag(tag);
      pushed = true;
    } catch (err: any) {
      error = `tag created locally but push failed: ${err.message}`;
    }
  }
  return { tag, created: true, pushed, commit: target, error };
}

/**
 * Deletes a temporary branch only when it is fully contained in the production
 * lineage, and only when the caller explicitly asked for it.
 */
export async function cleanupBranch(
  ctx: ProjectContext,
  branch: string,
  requested: boolean,
): Promise<string> {
  if (!(await ctx.git.localBranchExists(branch))) {
    return `— "${branch}" is already gone locally`;
  }
  const sha = await ctx.git.revParse(branch);
  const merged = sha ? await ctx.git.isAncestor(sha, ctx.strategy.productionBranch) : false;
  if (!merged) {
    return `⚠ "${branch}" is NOT fully merged into "${ctx.strategy.productionBranch}" — left in place`;
  }
  if (!requested) {
    return `— "${branch}" is merged and safe to delete: re-run with delete_release_branch: true`;
  }

  const current = await ctx.git.currentBranch();
  if (current === branch) await ctx.git.checkout(ctx.strategy.productionBranch);
  try {
    await ctx.git.deleteLocalBranch(branch);
  } catch (err: any) {
    return `⚠ could not delete "${branch}" — ${err.message}`;
  }
  let remoteNote = '';
  if (await ctx.git.hasRemote()) {
    try {
      if (await ctx.git.remoteBranchExists(branch)) {
        await ctx.git.deleteRemoteBranch(branch);
        remoteNote = ' (local and origin)';
      }
    } catch (err: any) {
      remoteNote = ` (local only — origin delete failed: ${err.message})`;
    }
  }
  return `✓ deleted "${branch}"${remoteNote}`;
}
