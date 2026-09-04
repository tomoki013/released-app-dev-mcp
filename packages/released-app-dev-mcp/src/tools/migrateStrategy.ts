import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME, isStrategyName, saveConfig, type AppDevConfig, type StrategyName } from '../core/config.js';
import { requireManaged, resolveProject, type ProjectContext } from '../core/context.js';
import { isManagedFile, writeManagedFile, type StepResult } from '../core/files.js';
import { createStrategy, activeReleaseBranches } from '../strategies/index.js';
import { workflowsFor } from '../workflows/index.js';

export interface MigrateStrategyOptions {
  to: string;
  /** Defaults to true — a migration always shows its plan before it touches anything. */
  dryRun?: boolean;
  /** Required for the lossy large -> small direction. */
  confirm?: boolean;
}

export async function migrateStrategy(ctx: ProjectContext, opts: MigrateStrategyOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  if (!isStrategyName(opts.to)) {
    return `Unknown strategy "${opts.to}". Valid values: "small", "large".`;
  }
  const from = ctx.config.strategy;
  const to: StrategyName = opts.to;
  if (from === to) return `This repository is already on the "${to}" strategy. Nothing to migrate.`;

  const dryRun = opts.dryRun ?? true;
  const oldDevelopment = ctx.strategy.developmentBranch;
  const newConfig: AppDevConfig = {
    ...ctx.config,
    strategy: to,
    branches: { ...ctx.config.branches, development: to === 'large' ? 'develop' : 'release' },
  };
  const newStrategy = createStrategy(newConfig);
  const newDevelopment = newStrategy.developmentBranch;

  if (to === 'small') {
    const blockers = await largeToSmallBlockers(ctx);
    if (blockers.length > 0) {
      return [
        `migrate_strategy(to: "small") — blocked.`,
        '',
        ...blockers.map((b) => `✗ ${b}`),
        '',
        'large -> small collapses develop and every release candidate into a single line.',
        'Land or close the work above first.',
      ].join('\n');
    }
    if (!opts.confirm) {
      return [
        `migrate_strategy(to: "small") — confirmation required.`,
        '',
        `Going large -> small merges "${oldDevelopment}" into "${newDevelopment}" and gives up the`,
        'per-version release candidate branch. That is not reversible by re-running the tool.',
        '',
        `Re-run with confirm: true (and dry_run: false) once you are sure.`,
      ].join('\n');
    }
  }

  const steps: StepResult[] = [];

  // 1. development branch carry-over.
  const oldExists = await ctx.git.localBranchExists(oldDevelopment);
  const newExists = await ctx.git.localBranchExists(newDevelopment);
  if (newExists) {
    if (oldExists) {
      const preview = await ctx.git.previewMerge(newDevelopment, oldDevelopment);
      steps.push({
        ok: preview.state !== 'conflict',
        line:
          preview.state === 'up-to-date'
            ? `"${newDevelopment}" already contains "${oldDevelopment}"`
            : preview.state === 'conflict'
              ? `"${newDevelopment}" exists and conflicts with "${oldDevelopment}" (${preview.conflictingFiles.join(', ')}) — merge it manually first`
              : `"${newDevelopment}" exists — merge "${oldDevelopment}" into it manually to carry the work over`,
      });
    } else {
      steps.push({ ok: true, line: `"${newDevelopment}" already exists` });
    }
  } else if (!oldExists) {
    steps.push({ ok: false, line: `neither "${oldDevelopment}" nor "${newDevelopment}" exists — run setup_repository` });
  } else {
    if (!dryRun) {
      const original = await ctx.git.currentBranch();
      await ctx.git.createBranch(newDevelopment, oldDevelopment);
      if (original && original !== newDevelopment) await ctx.git.checkout(original).catch(() => undefined);
    }
    steps.push({ ok: true, line: `"${newDevelopment}" created from "${oldDevelopment}" (full history carried over)` });
  }

  // 2. config.
  if (!dryRun) saveConfig(ctx.cwd, newConfig);
  steps.push({ ok: true, line: `${CONFIG_FILENAME}: strategy ${from} -> ${to}, development branch "${newDevelopment}"` });

  // 3. workflows: write the new set, retire the managed files the new set doesn't use.
  const project = await resolveProject(ctx);
  if (!project || !project.scheme) {
    steps.push({ ok: false, line: 'could not detect the Xcode project — workflows not regenerated' });
  } else {
    const nextFiles = workflowsFor(project, newConfig);
    for (const file of nextFiles) steps.push(writeManagedFile(ctx.cwd, file.path, file.content, dryRun));

    const keep = new Set(nextFiles.map((f) => f.path));
    for (const file of workflowsFor(project, ctx.config)) {
      if (keep.has(file.path)) continue;
      const abs = join(ctx.cwd, file.path);
      if (!existsSync(abs)) continue;
      if (!isManagedFile(abs)) {
        steps.push({ ok: false, line: `left custom ${file.path} in place — it belongs to the old strategy` });
        continue;
      }
      if (!dryRun) unlinkSync(abs);
      steps.push({ ok: true, line: `${file.path} removed (belonged to the "${from}" strategy)` });
    }
  }

  // 4. old branch — reported, never deleted.
  if (oldExists) {
    steps.push({
      ok: true,
      line: `"${oldDevelopment}" left in place. Delete it yourself once "${newDevelopment}" is confirmed to contain everything.`,
    });
    // refs/heads/release and refs/heads/release/1.4.0 cannot coexist.
    const releaseRef = newConfig.branches.releasePrefix.replace(/\/$/, '');
    if (to === 'large' && oldDevelopment === releaseRef) {
      steps.push({
        ok: false,
        line: `"${oldDevelopment}" must be deleted before the first release: Git cannot create "${newConfig.branches.releasePrefix}X.Y.Z" while a branch named "${releaseRef}" exists (git branch -d ${releaseRef}, and delete it on origin too).`,
      });
    }
  }

  const header = dryRun
    ? `migrate_strategy(to: "${to}", dry_run: true) — plan only`
    : `migrate_strategy(to: "${to}")`;
  const footer = dryRun
    ? `No changes were made. Re-run with dry_run: false${to === 'small' ? ', confirm: true' : ''} to apply.`
    : [
        'Migration applied.',
        `Feature branches now target "${newDevelopment}".`,
        to === 'large'
          ? 'Releases now cut a release/X.Y.Z candidate branch via prepare_release.'
          : 'Releases now ship straight from the "release" branch.',
      ].join('\n');

  return [header, '', ...steps.map((s) => `${s.ok ? '✓' : '⚠'} ${s.line}`), '', footer].join('\n');
}

async function largeToSmallBlockers(ctx: ProjectContext): Promise<string[]> {
  const blockers: string[] = [];
  const active = (await activeReleaseBranches(ctx, ctx.config.branches.releasePrefix)).filter(
    (b) => b !== ctx.strategy.developmentBranch,
  );
  if (active.length) blockers.push(`release candidate branch(es) still in flight: ${active.join(', ')}`);

  const hotfixes = await ctx.git.listLocalBranchesWithPrefix(ctx.config.branches.hotfixPrefix);
  if (hotfixes.length) blockers.push(`hotfix branch(es) still open: ${hotfixes.join(', ')}`);

  const tree = await ctx.git.workingTreeStatus();
  if (!tree.clean) blockers.push('working tree is dirty');
  return blockers;
}
