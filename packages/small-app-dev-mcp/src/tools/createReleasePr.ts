import { createPullRequest, findOpenPullRequest } from '@app-dev/git-core';
import type { ProjectContext } from '../context.js';
import { resolveGitHubClient } from '../context.js';

export interface CreateReleasePrOptions {
  version: string;
  dryRun?: boolean;
}

const CATEGORY_RULES: Array<{ label: string; test: RegExp }> = [
  { label: 'Features', test: /^feat(\(.+\))?[:!]/i },
  { label: 'Fixes', test: /^fix(\(.+\))?[:!]/i },
  { label: 'Maintenance', test: /^(chore|refactor|build|ci)(\(.+\))?[:!]/i },
  { label: 'Documentation', test: /^docs(\(.+\))?[:!]/i },
];

export async function createReleasePr(ctx: ProjectContext, opts: CreateReleasePrOptions): Promise<string> {
  const { config } = ctx;
  const prodBranch = config.workflow.production_branch;
  const devBranch = config.workflow.development_branch;
  const title = `Release ${opts.version}`;

  if (!ctx.githubToken) {
    return 'GITHUB_TOKEN is not set — cannot create a pull request.';
  }

  const commits = await ctx.git.logRange(`${prodBranch}..${devBranch}`);
  const body = buildReleaseBody(commits);

  if (opts.dryRun) {
    return [
      `create_release_pr(version: "${opts.version}", dry_run: true)`,
      '',
      `Would open PR: "${title}" (${devBranch} -> ${prodBranch})`,
      '',
      'Body preview:',
      body,
      '',
      'No changes were made.',
    ].join('\n');
  }

  const github = await resolveGitHubClient(ctx);
  const existing = await findOpenPullRequest(github, devBranch, prodBranch);
  if (existing) {
    return `Release PR already open: #${existing.number} ${existing.url}`;
  }

  const pr = await createPullRequest(github, { head: devBranch, base: prodBranch, title, body });
  return `Created release PR #${pr.number}: ${pr.url}`;
}

function buildReleaseBody(commits: Array<{ message: string }>): string {
  const groups = new Map<string, string[]>();
  const other: string[] = [];

  for (const commit of commits) {
    const firstLine = commit.message.split('\n')[0];
    const rule = CATEGORY_RULES.find((r) => r.test.test(firstLine));
    if (rule) {
      const cleaned = firstLine.replace(rule.test, '').trim();
      const list = groups.get(rule.label) ?? [];
      list.push(cleaned || firstLine);
      groups.set(rule.label, list);
    } else {
      other.push(firstLine);
    }
  }

  const sections: string[] = [];
  for (const rule of CATEGORY_RULES) {
    const items = groups.get(rule.label);
    if (items?.length) {
      sections.push(`${rule.label}\n${items.map((i) => `- ${i}`).join('\n')}`);
    }
  }
  if (other.length) {
    sections.push(`Other\n${other.map((i) => `- ${i}`).join('\n')}`);
  }

  return sections.length ? sections.join('\n\n') : '_No commits found between the two branches._';
}
