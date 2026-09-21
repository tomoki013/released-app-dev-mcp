import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { highestVersionTag } from '@app-dev/git-core';
import { releaseNotesCheck } from '../core/checks.js';
import { CONFIG_FILENAME } from '../core/config.js';
import { GITHUB_TOKEN_HINT, resolveGitHubClient, resolveProject, type ProjectContext } from '../core/context.js';
import { loadState } from '../core/state.js';
import { activeReleaseBranches, strategyNames } from '../strategies/index.js';
import { parseManagedHeader, TEMPLATE_VERSION, workflowPathsFor, workflowsFor } from '../workflows/index.js';

interface Finding {
  severity: 'error' | 'warning' | 'info';
  id: string;
  message: string;
  fix: string;
}

/**
 * Diagnosis only. Every finding says what to run, but nothing is changed —
 * a repair that guesses is exactly how a shipped app's history gets damaged.
 */
export async function doctor(ctx: ProjectContext): Promise<string> {
  if (!(await ctx.git.isRepo())) {
    return 'This directory is not a Git repository.';
  }

  const findings: Finding[] = [];
  const strategy = ctx.strategy;
  const production = strategy.productionBranch;
  const development = strategy.developmentBranch;

  // --- config -------------------------------------------------------------
  if (!ctx.configFound) {
    findings.push({
      severity: 'error',
      id: 'config_missing',
      message: `No ${CONFIG_FILENAME} — this repository is unmanaged, so the Git strategy is not pinned.`,
      fix: 'setup_repository(strategy: "small" | "large")',
    });
  } else if (ctx.configFromLegacy) {
    findings.push({
      severity: 'warning',
      id: 'config_legacy',
      message: 'Only a legacy .appdev.yml is present.',
      fix: 'setup_repository(strategy: "small") to migrate it to ' + CONFIG_FILENAME,
    });
  }
  for (const error of ctx.configErrors) {
    findings.push({ severity: 'error', id: 'config_invalid', message: error, fix: `fix ${CONFIG_FILENAME} by hand` });
  }

  // --- branch structure ---------------------------------------------------
  for (const branch of strategy.branchPolicy().permanent) {
    if (!(await ctx.git.localBranchExists(branch))) {
      findings.push({
        severity: 'error',
        id: 'branch_missing',
        message: `Permanent branch "${branch}" is missing.`,
        fix: 'setup_repository()',
      });
    }
  }

  // A branch belonging to the *other* strategy usually means a half-done migration.
  for (const other of strategyNames().filter((n) => n !== strategy.name)) {
    const otherDevelopment = other === 'large' ? 'develop' : 'release';
    if (otherDevelopment !== development && (await ctx.git.localBranchExists(otherDevelopment))) {
      findings.push({
        severity: 'warning',
        id: 'strategy_mismatch',
        message:
          `Strategy is "${strategy.name}" but a "${otherDevelopment}" branch exists (the "${other}" strategy's development branch).` +
          (strategy.name === 'large' && otherDevelopment === ctx.config.branches.releasePrefix.replace(/\/$/, '')
            ? ` It also blocks every "${ctx.config.branches.releasePrefix}X.Y.Z" ref — Git cannot have both.`
            : ''),
        fix: `delete it, or migrate_strategy(to: "${other}") if that is what you actually want`,
      });
    }
  }

  // --- production lineage -------------------------------------------------
  const tags = await ctx.git.listTags();
  const productionTag = highestVersionTag(tags);
  if (ctx.config.lifecycle === 'released' && !productionTag) {
    findings.push({
      severity: 'error',
      id: 'tag_missing',
      message: 'No vX.Y.Z tag — the published App Store version is not recorded in Git.',
      fix: 'tag the published commit, then use finish_release for every future version',
    });
  }

  if (productionTag && (await ctx.git.localBranchExists(production))) {
    const direct = await ctx.git.logRange(`${productionTag}..${production}`);
    const nonMerge = await ctx.git
      .raw(['log', '--no-merges', '--format=%h %s', `${productionTag}..${production}`])
      .then((out) => out.split('\n').filter(Boolean))
      .catch(() => [] as string[]);
    if (nonMerge.length > 0) {
      findings.push({
        severity: 'warning',
        id: 'direct_production_commit',
        message: `"${production}" has ${nonMerge.length} non-merge commit(s) since ${productionTag} — someone committed straight to the production lineage.`,
        fix: 'land changes through a release or hotfix PR; enable branch protection via setup_repository',
      });
    } else if (direct.length > 0) {
      findings.push({
        severity: 'info',
        id: 'untagged_production',
        message: `"${production}" is ${direct.length} merge(s) ahead of ${productionTag} — a release may not have been finished.`,
        fix: 'finish_release(version: "x.y.z") once that version is live',
      });
    }
  }

  // --- divergence ---------------------------------------------------------
  if ((await ctx.git.localBranchExists(development)) && (await ctx.git.localBranchExists(production))) {
    const diff = await ctx.git.aheadBehind(production, development);
    if (diff.behind > 0) {
      findings.push({
        severity: 'error',
        id: 'development_behind',
        message: `"${development}" is missing ${diff.behind} commit(s) from "${production}" — the next release would revert them.`,
        fix: 'sync_release()',
      });
    }
  }

  // --- hotfixes -----------------------------------------------------------
  const hotfixBranches = await ctx.git.listLocalBranchesWithPrefix(ctx.config.branches.hotfixPrefix);
  const syncTargets = await strategy.hotfixSyncTargets(ctx);
  for (const branch of hotfixBranches) {
    const sha = await ctx.git.revParse(branch);
    if (!sha) continue;
    const inProduction = await ctx.git.isAncestor(sha, production);
    if (!inProduction) {
      findings.push({
        severity: 'info',
        id: 'hotfix_open',
        message: `Hotfix "${branch}" is not merged into "${production}".`,
        fix: `finish_hotfix(name: "${branch.replace(ctx.config.branches.hotfixPrefix, '')}")`,
      });
      continue;
    }
    for (const target of syncTargets) {
      if (!(await ctx.git.localBranchExists(target.branch))) continue;
      if (!(await ctx.git.isAncestor(sha, target.branch))) {
        findings.push({
          severity: 'error',
          id: 'hotfix_unsynced',
          message: `Hotfix "${branch}" is on "${production}" but not in "${target.branch}" — it would be reverted by the next release.`,
          fix: 'sync_release()',
        });
      }
    }
  }

  // --- release candidates -------------------------------------------------
  const active = (await activeReleaseBranches(ctx, ctx.config.branches.releasePrefix)).filter(
    (b) => b !== development,
  );
  for (const branch of active) {
    const sha = await ctx.git.revParse(branch);
    if (sha && (await ctx.git.isAncestor(sha, production))) {
      findings.push({
        severity: 'warning',
        id: 'release_branch_abandoned',
        message: `"${branch}" is fully merged into "${production}" but still exists.`,
        fix: 'finish_release(version: "x.y.z", delete_release_branch: true)',
      });
    }
  }
  if (active.length > 1) {
    findings.push({
      severity: 'warning',
      id: 'multiple_release_candidates',
      message: `More than one release candidate in flight: ${active.join(', ')}.`,
      fix: 'ship or abandon the older candidate before cutting another',
    });
  }

  const state = loadState(ctx.cwd);
  for (const candidate of state.candidates) {
    if (!(await ctx.git.localBranchExists(candidate.releaseBranch))) {
      findings.push({
        severity: 'warning',
        id: 'candidate_branch_gone',
        message: `Recorded candidate ${candidate.version} points at "${candidate.releaseBranch}", which no longer exists.`,
        fix: `finish_release(version: "${candidate.version}") if it shipped, or ignore it if it was abandoned`,
      });
      continue;
    }
    const notes = await releaseNotesCheck(ctx, candidate.releaseBranch, candidate.version);
    if (!notes.ok && notes.severity === 'error') {
      findings.push({
        severity: 'warning',
        id: 'release_notes_missing',
        message: `Candidate ${candidate.version} on "${candidate.releaseBranch}" has no App Store "What's New" yet — ${notes.detail}`,
        fix: `write .appstore/<locale>/whats_new.txt on "${candidate.releaseBranch}"; finish_release will refuse to tag without it`,
      });
    }
    // A candidate takes fixes only. The rule is enforced by people, so show
    // them what landed since the freeze and let them judge each commit.
    const since = await ctx.git.logRange(`${candidate.commit}..${candidate.releaseBranch}`).catch(() => []);
    if (since.length > 0) {
      const shown = since.slice(0, MAX_LISTED_COMMITS);
      findings.push({
        severity: 'info',
        id: 'release_branch_commits',
        message:
          `"${candidate.releaseBranch}" has ${since.length} commit(s) since candidate ${candidate.version} was prepared at ${candidate.commit.slice(0, 7)} — each one should be a fix, not a feature:\n` +
          shown.map((c) => `      ${c.hash.slice(0, 7)} ${c.message.split('\n')[0]}`).join('\n') +
          (since.length > shown.length ? `\n      ... ${since.length - shown.length} more` : ''),
        fix: `move anything that is not a fix to "${development}"; re-run prepare_release(version: "${candidate.version}") to re-record the candidate`,
      });
    }
  }

  // --- workflows ----------------------------------------------------------
  const project = await resolveProject(ctx);
  if (!project || !project.scheme) {
    findings.push({
      severity: 'warning',
      id: 'project_undetected',
      message: 'No Xcode project/scheme could be detected, so workflows cannot be verified.',
      fix: `set "project.path" / "project.scheme" in ${CONFIG_FILENAME}`,
    });
  } else {
    for (const file of workflowsFor(project, ctx.config)) {
      const abs = join(ctx.cwd, file.path);
      if (!existsSync(abs)) {
        findings.push({
          severity: 'warning',
          id: 'workflow_missing',
          message: `${file.path} is missing for the "${strategy.name}" strategy.`,
          fix: 'setup_repository()',
        });
        continue;
      }
      const current = readFileSafe(abs);
      const header = parseManagedHeader(current);
      if (!header.managed || header.customized || current === file.content) continue;
      if (header.templateVersion === null || header.templateVersion < TEMPLATE_VERSION) {
        findings.push({
          severity: 'info',
          id: 'workflow_outdated',
          message: `${file.path} was generated from template v${header.templateVersion ?? '?'}; the current template is v${TEMPLATE_VERSION}.`,
          fix: 'setup_repository(dry_run: true) to see the diff, then setup_repository(overwrite_workflows: true) — hand edits in the file will be lost, so mark its first line "(customized)" instead if you want to keep them',
        });
      } else {
        findings.push({
          severity: 'info',
          id: 'workflow_edited',
          message: `${file.path} has been edited by hand since it was generated (template v${TEMPLATE_VERSION}).`,
          fix: 'change its first line to "# managed-by: released-app-dev-mcp (customized)" so setup_repository never regenerates it — or setup_repository(overwrite_workflows: true) to discard the edits',
        });
      }
    }
    findings.push(...pullRequestTriggerFindings(ctx));
    const expected = new Set(workflowsFor(project, ctx.config).map((f) => f.path));
    for (const other of strategyNames().filter((n) => n !== strategy.name)) {
      for (const path of workflowPathsFor(other)) {
        if (expected.has(path)) continue;
        if (existsSync(join(ctx.cwd, path))) {
          findings.push({
            severity: 'warning',
            id: 'workflow_stale',
            message: `${path} belongs to the "${other}" strategy but this repository is "${strategy.name}".`,
            fix: 'remove it, or migrate_strategy if the strategy is wrong',
          });
        }
      }
    }
  }

  // --- branch protection --------------------------------------------------
  if (ctx.githubToken) {
    try {
      const github = await resolveGitHubClient(ctx);
      for (const branch of strategy.branchPolicy().noDirectPush.filter((b) => !b.includes('*'))) {
        if (!(await github.isBranchProtectionConfigured(branch))) {
          findings.push({
            severity: 'warning',
            id: 'branch_protection_missing',
            message: `"${branch}" is not protected on GitHub — direct pushes and force-pushes are possible.`,
            fix: 'setup_repository(configure_branch_protection: true)',
          });
        }
      }
    } catch (err: any) {
      findings.push({
        severity: 'info',
        id: 'github_unreachable',
        message: `GitHub checks skipped — ${err.message}`,
        fix: 'set GITHUB_TOKEN with repo scope',
      });
    }
  } else {
    findings.push({
      severity: 'info',
      id: 'no_github_token',
      message: 'No GitHub credentials — CI and branch-protection checks were skipped.',
      fix: GITHUB_TOKEN_HINT,
    });
  }

  return formatFindings(ctx, findings);
}

const MAX_LISTED_COMMITS = 10;

/**
 * A PR into the development branch or a release candidate that no workflow
 * runs on merges untested. Every workflow counts here, including hand-written
 * ones this MCP does not manage — the question is coverage, not ownership.
 */
function pullRequestTriggerFindings(ctx: ProjectContext): Finding[] {
  const dir = join(ctx.cwd, '.github', 'workflows');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const patterns: string[] = [];
  let anyPullRequest = false;
  for (const file of files) {
    let doc: any;
    try {
      doc = yaml.load(readFileSafe(join(dir, file)));
    } catch {
      continue;
    }
    // Some YAML parsers read the bare key `on` as boolean true.
    const on = doc?.on ?? doc?.true;
    const trigger = ['pull_request', 'pull_request_target'].map((e) => triggerConfig(on, e)).find((t) => t.present);
    if (!trigger) continue;
    anyPullRequest = true;
    const branches = trigger.config?.branches;
    if (branches === undefined) return []; // No branch filter: every PR runs it.
    patterns.push(...(Array.isArray(branches) ? branches : [branches]).map(String));
  }

  const strategy = ctx.strategy;
  const required: Array<{ label: string; sample: string }> = [
    { label: strategy.productionBranch, sample: strategy.productionBranch },
    { label: strategy.developmentBranch, sample: strategy.developmentBranch },
  ];
  if (strategy.releaseBranchPlan('0.0.0').temporary) {
    const prefix = ctx.config.branches.releasePrefix;
    required.push({ label: `${prefix}*`, sample: `${prefix}0.0.0` });
  }
  if (!anyPullRequest) {
    return [
      {
        severity: 'warning',
        id: 'ci_pr_trigger_missing',
        message: 'No workflow runs on pull requests — nothing is tested before a merge.',
        fix: 'setup_repository() generates ci.yml, or add a pull_request trigger to your own workflow',
      },
    ];
  }
  const uncovered = required.filter((r) => !patterns.some((p) => branchGlobMatches(p, r.sample)));
  if (uncovered.length === 0) return [];
  return [
    {
      severity: 'warning',
      id: 'ci_pr_trigger_missing',
      message: `No workflow runs on pull requests into ${uncovered.map((u) => `"${u.label}"`).join(', ')} — those PRs merge untested.`,
      fix: 'add them to pull_request.branches in your CI workflow (the managed ci.yml covers all of them: setup_repository)',
    },
  ];
}

/** Whether `on` declares `event`, and its config when it has one (`on: [pull_request]` and a bare `pull_request:` have none). */
function triggerConfig(on: unknown, event: string): { present: boolean; config: any } {
  if (typeof on === 'string') return { present: on === event, config: null };
  if (Array.isArray(on)) return { present: on.includes(event), config: null };
  if (on && typeof on === 'object' && event in on) return { present: true, config: (on as any)[event] };
  return { present: false, config: null };
}

/** GitHub's branch filter globs: `*` stays within one segment, `**` spans segments. */
function branchGlobMatches(pattern: string, branch: string): boolean {
  if (pattern.startsWith('!')) return false;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ /g, '.*');
  return new RegExp(`^${re}$`).test(branch);
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function formatFindings(ctx: ProjectContext, findings: Finding[]): string {
  const header = [
    `doctor  [strategy: ${ctx.strategy.name}, lifecycle: ${ctx.config.lifecycle}]`,
    '',
  ];
  if (findings.length === 0) {
    return [...header, '✓ No policy violations found.'].join('\n');
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const body = sorted.map((f) => {
    const mark = f.severity === 'error' ? '✗' : f.severity === 'warning' ? '⚠' : 'ℹ';
    return `${mark} [${f.id}] ${f.message}\n    fix: ${f.fix}`;
  });

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return [
    ...header,
    ...body,
    '',
    `${errors} error(s), ${warnings} warning(s). Nothing was changed — run the suggested tools yourself.`,
  ].join('\n');
}
