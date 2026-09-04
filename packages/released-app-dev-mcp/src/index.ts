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
  version: '0.2.0',
});

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

async function ctx() {
  return buildContext(PROJECT_DIR);
}

server.tool(
  'get_app_status',
  'START HERE in any released iOS app repository. Reports whether the repo is managed by this MCP, its Git strategy (small/large), branch state, production tag, active release/hotfix, CI, blocking issues and the recommended next action.',
  {},
  async () => text(await getAppStatus(await ctx())),
);

server.tool(
  'setup_repository',
  'Register a released app with this MCP: write .app-dev-mcp.json (pinning the small/large strategy), create the development branch, generate the strategy-specific GitHub Actions workflows and PR template, and configure branch protection. Idempotent; never destroys existing files.',
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
      .describe('Also configure GitHub branch protection (requires GITHUB_TOKEN). Default true.'),
  },
  async ({ strategy, lifecycle, dry_run, configure_branch_protection }) =>
    text(
      await setupRepository(await ctx(), {
        strategy,
        lifecycle,
        dryRun: dry_run,
        configureBranchProtection: configure_branch_protection,
      }),
    ),
);

server.tool(
  'prepare_release',
  'Validate and prepare a release candidate for the given version. small: validates the release branch. large: cuts release/X.Y.Z from develop. Checks clean tree, version/tag availability, un-synced hotfixes, committed secrets and CI.',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('List what would be checked and created without doing it.'),
  },
  async ({ version, dry_run }) => text(await prepareRelease(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'create_release_pr',
  'Open the release candidate -> production pull request with an auto-generated change summary. Never merges it.',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('Preview the PR title/body without creating it.'),
  },
  async ({ version, dry_run }) => text(await createReleasePr(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'finish_release',
  'Run this AFTER the version is live on the App Store. Confirms the release commit reached the production branch, creates and pushes the vX.Y.Z tag (never overwriting one), syncs the release back into the development line, and retires the temporary release branch.',
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
  'Create a hotfix branch from the production lineage (main) for an urgent fix to the currently published version. Never branches from a development branch.',
  {
    name: z.string().describe('Short name for the hotfix, e.g. "startup crash".'),
    version: z.string().optional().describe('Target hotfix version, e.g. "1.0.1" — used for the branch name and tag.'),
    dry_run: z.boolean().optional(),
  },
  async ({ name, version, dry_run }) => text(await startHotfix(await ctx(), { name, version, dryRun: dry_run })),
);

server.tool(
  'finish_hotfix',
  'Land a hotfix: verifies the branch, opens its PR into main (or merges it when GitHub is unreachable), then — once merged — tags the published version and syncs the fix into the development branch and any in-flight release candidate. Stops on conflicts instead of resolving them.',
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
  'Merge the production branch into the development line — "release" for the small strategy, "develop" plus every in-flight release/X.Y.Z for the large strategy. Use after a hotfix has landed on main.',
  {
    dry_run: z.boolean().optional(),
  },
  async ({ dry_run }) => text(await syncRelease(await ctx(), { dryRun: dry_run })),
);

server.tool(
  'migrate_strategy',
  'Move this repository between Git strategies (small -> large is the supported direction). Always dry-runs by default; large -> small additionally requires confirm: true. Never deletes branches.',
  {
    to: z.enum(['small', 'large']).describe('Target strategy.'),
    dry_run: z.boolean().optional().describe('Defaults to true — pass false to apply the plan.'),
    confirm: z.boolean().optional().describe('Required for the lossy large -> small direction.'),
  },
  async ({ to, dry_run, confirm }) => text(await migrateStrategy(await ctx(), { to, dryRun: dry_run, confirm })),
);

server.tool(
  'doctor',
  'Diagnose this repository against the released-app Git policy: missing config, wrong branch structure, missing production tag, direct commits to main, un-synced hotfixes, abandoned release branches, divergence, wrong/stale workflows, strategy mismatch and branch protection. Reports only — never repairs.',
  {},
  async () => text(await doctor(await ctx())),
);

const transport = new StdioServerTransport();
await server.connect(transport);
