import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectContext } from '../context.js';
import { resolveGitHubClient, resolveProject } from '../context.js';
import { serializeConfig, DEFAULT_CONFIG, CONFIG_FILENAME } from '../config.js';
import { generateCiYaml, generateReleaseYaml, generatePullRequestTemplate, MANAGED_MARKER_YAML, MANAGED_MARKER_MD } from '../workflows.js';

export interface SetupRepositoryOptions {
  dryRun?: boolean;
  /** Configure GitHub branch protection on the production branch. Requires GITHUB_TOKEN. Defaults to on. */
  configureBranchProtection?: boolean;
}

interface StepResult {
  ok: boolean;
  line: string;
}

export async function setupRepository(ctx: ProjectContext, opts: SetupRepositoryOptions = {}): Promise<string> {
  const dryRun = opts.dryRun ?? false;
  const configureBranchProtection = opts.configureBranchProtection ?? true;
  const devBranch = ctx.config.workflow.development_branch;
  const prodBranch = ctx.config.workflow.production_branch;

  const isRepo = await ctx.git.isRepo();
  if (!isRepo) {
    return 'This directory is not a Git repository. Run `git init` first.';
  }

  const steps: StepResult[] = [];

  // 1. .appdev.yml — never overwritten once it exists; it's the user's source of truth.
  const appdevPath = join(ctx.cwd, CONFIG_FILENAME);
  if (existsSync(appdevPath)) {
    steps.push({ ok: true, line: `${CONFIG_FILENAME} already exists` });
  } else {
    if (!dryRun) writeFileSync(appdevPath, serializeConfig(DEFAULT_CONFIG), 'utf-8');
    steps.push({ ok: true, line: `${CONFIG_FILENAME} created` });
  }

  // 2. release branch
  const devExists = await ctx.git.localBranchExists(devBranch);
  if (devExists) {
    steps.push({ ok: true, line: `"${devBranch}" branch already exists` });
  } else {
    if (!dryRun) await ctx.git.createBranch(devBranch, prodBranch);
    steps.push({ ok: true, line: `"${devBranch}" branch created from "${prodBranch}"` });
  }

  // 3. CI / Release workflows + PR template — only generated when the iOS
  // project can be resolved (path + scheme), so we never write a workflow
  // with a placeholder scheme/project in it.
  const project = await resolveProject(ctx);
  if (!project || !project.scheme) {
    steps.push({
      ok: false,
      line:
        'Could not detect an Xcode project/scheme — skipped ci.yml and release.yml. ' +
        `Add "project.path" / "project.scheme" to ${CONFIG_FILENAME} and re-run setup_repository.`,
    });
  } else {
    steps.push(
      writeManagedFile(ctx.cwd, '.github/workflows/ci.yml', generateCiYaml(project, ctx.config), dryRun),
    );
    steps.push(
      writeManagedFile(ctx.cwd, '.github/workflows/release.yml', generateReleaseYaml(project, ctx.config), dryRun),
    );
  }

  steps.push(
    writeManagedFile(ctx.cwd, '.github/pull_request_template.md', generatePullRequestTemplate(), dryRun),
  );

  // 4. main branch protection — checked for current state so re-runs are idempotent.
  if (!configureBranchProtection) {
    steps.push({ ok: true, line: 'main branch protection skipped (configure_branch_protection: false)' });
  } else if (!ctx.githubToken) {
    steps.push({ ok: false, line: 'main branch protection skipped — GITHUB_TOKEN not set' });
  } else {
    try {
      const github = await resolveGitHubClient(ctx);
      const alreadyConfigured = await github.isBranchProtectionConfigured(prodBranch);
      if (alreadyConfigured) {
        steps.push({ ok: true, line: `"${prodBranch}" protection already configured` });
      } else {
        if (!dryRun) await github.updateBranchProtection(prodBranch);
        steps.push({ ok: true, line: `"${prodBranch}" protection configured (PR required, force-push/delete blocked)` });
      }
    } catch (err: any) {
      steps.push({ ok: false, line: `main branch protection failed — ${err.message}` });
    }
  }

  const allOk = steps.every((s) => s.ok);
  const header = dryRun ? 'setup_repository (dry run)' : 'setup_repository';
  const body = steps.map((s) => `${s.ok ? '✓' : '⚠'} ${s.line}`);
  const footer = dryRun ? 'No changes were made.' : allOk ? 'No changes required beyond the above.' : '';

  return [header, '', ...body, footer].filter(Boolean).join('\n');
}

/** Writes `content` to `relPath` unless a file already exists there that this tool didn't generate. */
function writeManagedFile(cwd: string, relPath: string, content: string, dryRun: boolean): StepResult {
  const targetPath = join(cwd, relPath);
  const name = relPath.split('/').pop()!;

  if (existsSync(targetPath)) {
    if (isManagedFile(targetPath)) {
      const current = readFileSync(targetPath, 'utf-8');
      if (current === content) {
        return { ok: true, line: `${name} already configured` };
      }
      if (!dryRun) writeFileSync(targetPath, content, 'utf-8');
      return { ok: true, line: `${name} updated` };
    }
    return { ok: false, line: `Skipped existing custom ${name} (not managed by small-app-dev-mcp).` };
  }

  if (!dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }
  return { ok: true, line: `${name} created` };
}

function isManagedFile(path: string): boolean {
  let firstLine: string;
  try {
    firstLine = readFileSync(path, 'utf-8').split('\n', 1)[0];
  } catch {
    return false;
  }
  return firstLine === MANAGED_MARKER_YAML || firstLine === MANAGED_MARKER_MD;
}
