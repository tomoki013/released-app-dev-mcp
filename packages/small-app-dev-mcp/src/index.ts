#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContext } from './context.js';
import { getAppStatus } from './tools/getAppStatus.js';
import { setupRepository } from './tools/setupRepository.js';
import { prepareRelease } from './tools/prepareRelease.js';
import { createReleasePr } from './tools/createReleasePr.js';
import { startHotfix } from './tools/startHotfix.js';
import { finishHotfix } from './tools/finishHotfix.js';
import { syncRelease } from './tools/syncRelease.js';

const PROJECT_DIR = process.env.APP_DEV_PROJECT_DIR ?? process.cwd();

const server = new McpServer({
  name: 'small-app-dev-mcp',
  version: '0.1.0',
});

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

async function ctx() {
  return buildContext(PROJECT_DIR);
}

server.tool(
  'get_app_status',
  'Get the current release/hotfix/CI status of this small-app project: branches, working tree, CI, open PRs.',
  {},
  async () => text(await getAppStatus(await ctx())),
);

server.tool(
  'setup_repository',
  'Set up standard small-app-dev repository structure: release branch, .appdev.yml, CI/Release GitHub Actions workflows, PR template, and (optionally) main branch protection.',
  {
    dry_run: z.boolean().optional().describe('Preview actions without making changes.'),
    configure_branch_protection: z
      .boolean()
      .optional()
      .describe('Also configure GitHub branch protection on the production branch (requires GITHUB_TOKEN).'),
  },
  async ({ dry_run, configure_branch_protection }) =>
    text(
      await setupRepository(await ctx(), {
        dryRun: dry_run,
        configureBranchProtection: configure_branch_protection,
      }),
    ),
);

server.tool(
  'prepare_release',
  'Check whether the release branch is ready to be released as the given version (clean tree, CI passing, hotfixes synced, valid version, no conflicting PR).',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('List what would be checked without checking it.'),
  },
  async ({ version, dry_run }) => text(await prepareRelease(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'create_release_pr',
  'Open the release -> main pull request for the given version, with an auto-generated summary of changes.',
  {
    version: z.string().describe('Target release version, e.g. "1.1.0".'),
    dry_run: z.boolean().optional().describe('Preview the PR title/body without creating it.'),
  },
  async ({ version, dry_run }) => text(await createReleasePr(await ctx(), { version, dryRun: dry_run })),
);

server.tool(
  'start_hotfix',
  'Create a hotfix/* branch from main for an urgent fix to the currently published version.',
  {
    name: z.string().describe('Short name for the hotfix, e.g. "startup crash" — automatically slugified to "startup-crash".'),
    version: z.string().optional().describe('Optional target hotfix version, e.g. "1.0.1".'),
    dry_run: z.boolean().optional(),
  },
  async ({ name, version, dry_run }) => text(await startHotfix(await ctx(), { name, version, dryRun: dry_run })),
);

server.tool(
  'finish_hotfix',
  'Verify a hotfix branch is ready (clean tree, CI passing) and open its hotfix/* -> main pull request.',
  {
    name: z.string().describe('The hotfix name passed to start_hotfix.'),
    dry_run: z.boolean().optional(),
  },
  async ({ name, dry_run }) => text(await finishHotfix(await ctx(), { name, dryRun: dry_run })),
);

server.tool(
  'sync_release',
  'Merge the latest production branch (main) into the release branch. Use after a hotfix has been merged to main.',
  {
    dry_run: z.boolean().optional(),
  },
  async ({ dry_run }) => text(await syncRelease(await ctx(), { dryRun: dry_run })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
