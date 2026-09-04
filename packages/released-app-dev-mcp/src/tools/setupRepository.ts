import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { highestVersionTag } from '@app-dev/git-core';
import {
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  defaultConfig,
  isStrategyName,
  loadConfig,
  saveConfig,
  type Lifecycle,
  type StrategyName,
} from '../core/config.js';
import { resolveGitHubClient, resolveProject, type ProjectContext } from '../core/context.js';
import { ensureGitignoreEntry, writeManagedFile, type StepResult } from '../core/files.js';
import { STATE_FILENAME } from '../core/state.js';
import { createStrategy } from '../strategies/index.js';
import { generatePullRequestTemplate, workflowsFor } from '../workflows/index.js';

export interface SetupRepositoryOptions {
  strategy?: string;
  lifecycle?: string;
  dryRun?: boolean;
  configureBranchProtection?: boolean;
}

export async function setupRepository(ctx: ProjectContext, opts: SetupRepositoryOptions = {}): Promise<string> {
  const dryRun = opts.dryRun ?? false;
  const configureBranchProtection = opts.configureBranchProtection ?? true;

  if (!(await ctx.git.isRepo())) {
    return 'This directory is not a Git repository. Run `git init` first.';
  }

  const alreadyManaged = ctx.configFound && !ctx.configFromLegacy;
  if (alreadyManaged && opts.strategy && opts.strategy !== ctx.config.strategy) {
    return [
      `This repository is already registered with strategy "${ctx.config.strategy}".`,
      '',
      'setup_repository never changes a repository\'s strategy — an implicit switch would silently',
      `change the branch model of a shipped app. Use migrate_strategy(to: "${opts.strategy}") instead.`,
    ].join('\n');
  }

  if (opts.strategy && !isStrategyName(opts.strategy)) {
    return `Unknown strategy "${opts.strategy}". Valid values: "small", "large".`;
  }

  const strategyName: StrategyName | null = alreadyManaged
    ? ctx.config.strategy
    : ((opts.strategy as StrategyName | undefined) ?? null);

  if (!strategyName) {
    return proposeStrategy(ctx);
  }

  const lifecycle: Lifecycle = opts.lifecycle === 'development' ? 'development' : 'released';

  // Config first — every later step reads the strategy from it.
  const config = alreadyManaged
    ? { ...ctx.config }
    : {
        ...defaultConfig(strategyName, lifecycle),
        project: { ...ctx.config.project },
        // A legacy .appdev.yml carried real branch names; keep them.
        branches: ctx.configFromLegacy ? { ...ctx.config.branches } : defaultConfig(strategyName, lifecycle).branches,
      };
  config.strategy = strategyName;
  if (!alreadyManaged) config.lifecycle = lifecycle;
  if (!alreadyManaged && !ctx.configFromLegacy) {
    config.branches.development = strategyName === 'large' ? 'develop' : 'release';
  }

  const strategy = createStrategy(config);
  const steps: StepResult[] = [];

  if (alreadyManaged) {
    steps.push({ ok: true, line: `${CONFIG_FILENAME} already present (strategy: ${config.strategy})` });
  } else {
    if (!dryRun) saveConfig(ctx.cwd, config);
    steps.push({ ok: true, line: `${CONFIG_FILENAME} created (strategy: ${config.strategy}, lifecycle: ${config.lifecycle})` });
    if (ctx.configFromLegacy) {
      steps.push({
        ok: true,
        line: `migrated settings from ${LEGACY_CONFIG_FILENAME} (the old file is left in place — delete it once you are happy)`,
      });
    }
  }

  // Branches.
  const production = strategy.productionBranch;
  if (!(await ctx.git.localBranchExists(production))) {
    steps.push({ ok: false, line: `production branch "${production}" does not exist — create it before continuing` });
  } else {
    steps.push({ ok: true, line: `production branch "${production}" present` });
  }

  const development = strategy.developmentBranch;
  if (await ctx.git.localBranchExists(development)) {
    steps.push({ ok: true, line: `"${development}" branch already exists` });
  } else if (!(await ctx.git.localBranchExists(production))) {
    steps.push({ ok: false, line: `cannot create "${development}" — "${production}" is missing` });
  } else {
    const originalBranch = await ctx.git.currentBranch();
    if (!dryRun) {
      await ctx.git.createBranch(development, production);
      if (originalBranch && originalBranch !== development) await ctx.git.checkout(originalBranch);
    }
    steps.push({ ok: true, line: `"${development}" branch created from "${production}"` });
  }

  // Workflows + PR template — only written when the Xcode project resolves, so
  // we never commit a workflow containing a placeholder scheme.
  const project = await resolveProject(ctx);
  if (!project || !project.scheme) {
    steps.push({
      ok: false,
      line:
        'Could not detect an Xcode project/scheme — skipped GitHub Actions workflows. ' +
        `Add "project.path" / "project.scheme" to ${CONFIG_FILENAME} and re-run setup_repository.`,
    });
  } else {
    for (const file of workflowsFor(project, config)) {
      steps.push(writeManagedFile(ctx.cwd, file.path, file.content, dryRun));
    }
  }
  steps.push(writeManagedFile(ctx.cwd, '.github/pull_request_template.md', generatePullRequestTemplate(), dryRun));

  // The release-state cache is a working record, not repository content: the
  // durable record of a release is its annotated production tag.
  steps.push(ensureGitignoreEntry(ctx.cwd, STATE_FILENAME, dryRun));

  // Branch protection on every branch the strategy forbids direct pushes to
  // (globs like "release/*" are skipped — GitHub needs a ruleset for those).
  const protectable = strategy
    .branchPolicy()
    .noDirectPush.filter((b) => !b.includes('*'));
  if (!configureBranchProtection) {
    steps.push({ ok: true, line: 'branch protection skipped (configure_branch_protection: false)' });
  } else if (!ctx.githubToken) {
    steps.push({ ok: false, line: 'branch protection skipped — GITHUB_TOKEN not set' });
  } else {
    try {
      const github = await resolveGitHubClient(ctx);
      for (const branch of protectable) {
        if (await github.isBranchProtectionConfigured(branch)) {
          steps.push({ ok: true, line: `"${branch}" protection already configured` });
          continue;
        }
        if (!dryRun) await github.updateBranchProtection(branch);
        steps.push({ ok: true, line: `"${branch}" protection configured (PR required, force-push/delete blocked)` });
      }
      if (protectable.some((b) => b.includes('*')) || config.strategy === 'large') {
        steps.push({
          ok: true,
          line: `note: protect "${config.branches.releasePrefix}*" with a GitHub ruleset — the branch-protection API cannot match a pattern`,
        });
      }
    } catch (err: any) {
      steps.push({ ok: false, line: `branch protection failed — ${err.message}` });
    }
  }

  if (config.lifecycle === 'released' && !highestVersionTag(await ctx.git.listTags())) {
    steps.push({
      ok: false,
      line: 'no vX.Y.Z production tag found — tag the currently published commit so releases are traceable',
    });
  }

  const allOk = steps.every((s) => s.ok);
  const header = dryRun ? 'setup_repository (dry run)' : 'setup_repository';
  const footer = dryRun
    ? 'No changes were made.'
    : allOk
      ? 'Repository is registered and consistent.'
      : 'Registered, but the ⚠ items above still need attention.';

  return [header, '', ...steps.map((s) => `${s.ok ? '✓' : '⚠'} ${s.line}`), '', footer].join('\n');
}

/**
 * Strategy is never inferred silently — this only *proposes* one, with the
 * evidence behind the proposal, and stops so a human confirms it.
 */
function proposeStrategy(ctx: ProjectContext): string {
  const signals = largeSignals(ctx.cwd);
  const suggestion: StrategyName = signals.length >= 2 ? 'large' : 'small';

  return [
    'setup_repository needs an explicit strategy.',
    '',
    'The strategy fixes this repository\'s branch model for good, so it is recorded in',
    `${CONFIG_FILENAME} rather than re-guessed each session.`,
    '',
    '  small — main + release. Solo/small app, few parallel features, small migration risk.',
    '  large — main + develop + release/X.Y.Z. Backend, shared data, DB migrations, paid tiers,',
    '          parallel feature work, a candidate that needs a verification period.',
    '',
    signals.length ? `Signals found in this repository:\n${signals.map((s) => `  - ${s}`).join('\n')}` : 'No large-app signals found in this repository.',
    '',
    `Suggestion: "${suggestion}" (a suggestion only — you decide).`,
    '',
    `Re-run: setup_repository(strategy: "${suggestion}")`,
  ].join('\n');
}

function largeSignals(cwd: string): string[] {
  const signals: string[] = [];
  const dirCandidates = ['server', 'backend', 'api', 'functions', 'supabase', 'migrations'];
  let entries: string[] = [];
  try {
    entries = readdirSync(cwd);
  } catch {
    return signals;
  }
  for (const candidate of dirCandidates) {
    if (entries.includes(candidate)) signals.push(`"${candidate}/" directory (backend or migrations)`);
  }
  if (entries.some((e) => e.endsWith('.xcdatamodeld'))) signals.push('Core Data model (schema migrations)');
  if (existsSync(join(cwd, 'Package.swift'))) signals.push('Package.swift (multi-module project)');
  return signals;
}
