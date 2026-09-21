#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContext } from './core/context.js';
import { createReleasePr } from './tools/createReleasePr.js';
import { doctor } from './tools/doctor.js';
import { finishHotfix } from './tools/finishHotfix.js';
import { finishRelease } from './tools/finishRelease.js';
import { getAppStatus } from './tools/getAppStatus.js';
import { migrateStrategy } from './tools/migrateStrategy.js';
import { prepareRelease } from './tools/prepareRelease.js';
import { setupRepository } from './tools/setupRepository.js';
import { startHotfix } from './tools/startHotfix.js';
import { syncRelease } from './tools/syncRelease.js';

const PROJECT_DIR = process.env.APP_DEV_PROJECT_DIR ?? process.cwd();

const server = new McpServer({
  name: 'released-app-dev-mcp',
  version: '0.3.0',
});

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

async function ctx() {
  return buildContext(PROJECT_DIR);
}

server.tool(
  'get_app_status',
  'READ-ONLY. START HERE in any released iOS app repository. Reports whether the repo is managed by this MCP, its Git strategy (small/large), branch state, production tag, active release/hotfix, CI, blocking issues and the recommended next action. Runs no Git write commands.',
  {},
  async () => text(await getAppStatus(await ctx())),
);

server.tool(
  'setup_repository',
  'WRITES FILES AND BRANCHES. Register a released app with this MCP: writes .app-dev-mcp.json (pinning the small/large strategy), creates the development branch locally, writes .github/workflows/*.yml and the PR template, appends to .gitignore, and (with a GitHub token) configures branch protection on GitHub. Idempotent. Never pushes commits, never overwrites a hand-written file, and never replaces a managed workflow that differs from its template unless overwrite_workflows: true — use dry_run: true to see the diff first.',
  {
    strategy: z
      .enum(['small', 'large'])
      .optional()
      .describe('Required the first time. small = main + release. large = main + develop + release/X.Y.Z.'),
    lifecycle: z
      .enum(['development', 'released'])
      .optional()
      .describe('Defaults to "released" — set "development" only for an app that has never shipped.'),
    dry_run: z.boolean().optional().describe('Preview actions without making changes.'),
    configure_branch_protection: z
      .boolean()
      .optional()
      .describe('Also configure GitHub branch protection (needs GitHub credentials). Default true.'),
    overwrite_workflows: z
      .boolean()
      .optional()
      .describe(
        'Replace managed workflow files that differ from the current template (template upgrade or hand edits). Default false. Files whose first line says "(customized)" are never touched.',
      ),
  },
  async ({ strategy, lifecycle, dry_run, configure_branch_protection, overwrite_workflows }) =>
    text(
      await setupRepository(await ctx(), {
        strategy,
        lifecycle,
        dryRun: dry_run,
        configureBranchProtection: configure_branch_protection,
        overwriteWorkflows: overwrite_workflows,
      }),
    ),
);

server.tool(
  'prepare_release',
  'CREATES AND PUSHES A BRANCH (large strategy) and writes .app-dev-mcp.state.json. Validates and prepares a release candidate for the given version: checks clean tree, version/tag availability, un-synced hotfixes, committed secrets, CI, and that the App Store "What\'s New" (.appstore/<locale>/whats_new.txt, or a CHANGELOG.md section) was written for this version — it refuses to proceed without it. small: validates the existing release branch. large: creates release/X.Y.Z from develop and pushes it to origin. dry_run: true is read-only and also lists uncommitted files.',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('List what would be checked and created without doing it.'),
  },
  async ({ version, dry_run }) => text(await prepareRelease(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'create_release_pr',
  'CREATES A PULL REQUEST ON GITHUB (release candidate -> production) with an auto-generated change summary and the App Store "What\'s New" text for review. Never merges it. Needs GitHub credentials (GITHUB_TOKEN or gh auth login). dry_run: true only previews the title/body.',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('Preview the PR title/body without creating it.'),
  },
  async ({ version, dry_run }) => text(await createReleasePr(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'finish_release',
  'MERGES, TAGS AND PUSHES. Run this AFTER the version is live on the App Store. Refuses to run until the App Store "What\'s New" for the version exists on the release branch. Merges the release branch into the production branch if the PR was not used, creates and pushes the annotated vX.Y.Z tag (never overwriting an existing tag), merges production back into the development line and pushes, and (only with delete_release_branch: true) deletes the temporary release branch locally and on origin.',
  {
    version: z.string().describe('The version that is now live, e.g. "1.1.0".'),
    dry_run: z.boolean().optional(),
    delete_release_branch: z
      .boolean()
      .optional()
      .describe('Delete the temporary release/X.Y.Z branch (large strategy) once it is fully merged. Default false.'),
  },
  async ({ version, dry_run, delete_release_branch }) =>
    text(await finishRelease(await ctx(), { version, dryRun: dry_run, deleteReleaseBranch: delete_release_branch })),
);

server.tool(
  'start_hotfix',
  'CREATES AND CHECKS OUT A LOCAL BRANCH. Fetches origin and fast-forwards the local production branch (main), then creates hotfix/<version-or-name> from it for an urgent fix to the currently published version and leaves it checked out. Nothing is pushed. Never branches from a development branch.',
  {
    name: z.string().describe('Short name for the hotfix, e.g. "startup crash".'),
    version: z.string().optional().describe('Target hotfix version, e.g. "1.0.1" — used for the branch name and tag.'),
    dry_run: z.boolean().optional(),
  },
  async ({ name, version, dry_run }) => text(await startHotfix(await ctx(), { name, version, dryRun: dry_run })),
);

server.tool(
  'finish_hotfix',
  'CREATES A PULL REQUEST, OR MERGES, TAGS AND PUSHES. Two phases: while the hotfix is not on main it requires the App Store "What\'s New" on the hotfix branch, then opens its PR into main (or merges locally when GitHub is unreachable) and stops. Once merged, it creates and pushes the vX.Y.Z tag and merges main into the development branch and every in-flight release/X.Y.Z, pushing each. Stops on conflicts instead of resolving them.',
  {
    name: z.string().describe('The hotfix name passed to start_hotfix.'),
    version: z.string().optional().describe('The published hotfix version, e.g. "1.0.1". Needed to create the tag.'),
    dry_run: z.boolean().optional(),
    delete_branch: z.boolean().optional().describe('Delete the hotfix branch once fully merged. Default false.'),
  },
  async ({ name, version, dry_run, delete_branch }) =>
    text(await finishHotfix(await ctx(), { name, version, dryRun: dry_run, deleteBranch: delete_branch })),
);

server.tool(
  'sync_release',
  'MERGES AND PUSHES. Merges the production branch into the development line — "release" for the small strategy, "develop" plus every in-flight release/X.Y.Z for the large strategy — and pushes each merged branch. Use after a hotfix has landed on main. Stops on conflicts. dry_run: true only previews.',
  {
    dry_run: z.boolean().optional(),
  },
  async ({ dry_run }) => text(await syncRelease(await ctx(), { dryRun: dry_run })),
);

server.tool(
  'migrate_strategy',
  'REWRITES CONFIG AND WORKFLOWS, CREATES A BRANCH. Moves this repository between Git strategies (small -> large is the supported direction): creates the new development branch from the old one, rewrites .app-dev-mcp.json, replaces the managed workflow files. Dry-runs by default (dry_run: false to apply); large -> small additionally requires confirm: true. Never deletes branches.',
  {
    to: z.enum(['small', 'large']).describe('Target strategy.'),
    dry_run: z.boolean().optional().describe('Defaults to true — pass false to apply the plan.'),
    confirm: z.boolean().optional().describe('Required for the lossy large -> small direction.'),
  },
  async ({ to, dry_run, confirm }) => text(await migrateStrategy(await ctx(), { to, dryRun: dry_run, confirm })),
);

server.tool(
  'doctor',
  'READ-ONLY. Diagnoses this repository against the released-app Git policy: missing config, wrong branch structure, missing production tag, direct commits to main, un-synced hotfixes, abandoned release branches, commits on a frozen candidate, a candidate without App Store "What\'s New", divergence, outdated/hand-edited workflows, PR triggers that skip a branch, strategy mismatch and branch protection. Reports only — never repairs.',
  {},
  async () => text(await doctor(await ctx())),
);

const transport = new StdioServerTransport();
await server.connect(transport);
