import { createPullRequest, findOpenPullRequest } from '@app-dev/git-core';
import { requireManaged, resolveGitHubClient, type ProjectContext } from '../core/context.js';

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

/** Opens the release candidate -> production PR. Never merges it: that stays a human decision. */
export async function createReleasePr(ctx: ProjectContext, opts: CreateReleasePrOptions): Promise<string> {
  const unmanaged = requireManaged(ctx);
  if (unmanaged) return unmanaged;

  const strategy = ctx.strategy;
  const plan = strategy.releaseBranchPlan(opts.version);
  const production = strategy.productionBranch;
  const title = `Release ${opts.version}`;

  if (!(await ctx.git.localBranchExists(plan.branch))) {
    return `Release candidate branch "${plan.branch}" does not exist. Run prepare_release(version: "${opts.version}") first.`;
  }

  const commits = await ctx.git.logRange(`${production}..${plan.branch}`);
  const body = buildReleaseBody(opts.version, strategy.name, plan.branch, commits);

  if (opts.dryRun) {
    return [
      `create_release_pr(version: "${opts.version}", dry_run: true)  [strategy: ${strategy.name}]`,
      '',
      `Would open PR: "${title}" (${plan.branch} -> ${production})`,
      '',
      'Body preview:',
      body,
      '',
      'No changes were made.',
    ].join('\n');
  }

  if (!ctx.githubToken) {
    return 'GITHUB_TOKEN is not set — cannot create a pull request.';
  }

  const github = await resolveGitHubClient(ctx);
  const existing = await findOpenPullRequest(github, plan.branch, production);
  if (existing) {
    return `Release PR already open: #${existing.number} ${existing.url}`;
  }

  const pr = await createPullRequest(github, { head: plan.branch, base: production, title, body });
  return [
    `Created release PR #${pr.number}: ${pr.url}`,
    '',
    'This PR is not merged automatically. Merge it once the release is approved,',
    `then run finish_release(version: "${opts.version}") after the version is live on the App Store.`,
  ].join('\n');
}

function buildReleaseBody(
  version: string,
  strategy: string,
  branch: string,
  commits: Array<{ message: string }>,
): string {
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

  const sections: string[] = [`Release ${version} — prepared from \`${branch}\` (${strategy} strategy).`, ''];
  for (const rule of CATEGORY_RULES) {
    const items = groups.get(rule.label);
    if (items?.length) sections.push(`### ${rule.label}\n${items.map((i) => `- ${i}`).join('\n')}`);
  }
  if (other.length) sections.push(`### Other\n${other.map((i) => `- ${i}`).join('\n')}`);
  if (groups.size === 0 && other.length === 0) sections.push('_No commits found between the two branches._');

  sections.push('', `After the App Store release is live, run \`finish_release(version: "${version}")\`.`);
  return sections.join('\n');
}
