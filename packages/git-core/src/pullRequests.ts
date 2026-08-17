import type { GitHubClient } from './github.js';
import type { PullRequestRef } from './types.js';

function toPullRequestRef(pr: {
  number: number;
  html_url: string;
  title: string;
  state: string;
  merged_at?: string | null;
  head: { ref: string };
  base: { ref: string };
}): PullRequestRef {
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(pr.merged_at),
    head: pr.head.ref,
    base: pr.base.ref,
  };
}

export async function findOpenPullRequest(
  client: GitHubClient,
  head: string,
  base: string,
): Promise<PullRequestRef | null> {
  const { data } = await client.octokit.pulls.list({
    owner: client.owner,
    repo: client.repo,
    state: 'open',
    head: `${client.owner}:${head}`,
    base,
  });
  const found = data[0];
  return found ? toPullRequestRef(found as any) : null;
}

export async function createPullRequest(
  client: GitHubClient,
  params: { head: string; base: string; title: string; body: string; draft?: boolean },
): Promise<PullRequestRef> {
  const existing = await findOpenPullRequest(client, params.head, params.base);
  if (existing) return existing;

  const { data } = await client.octokit.pulls.create({
    owner: client.owner,
    repo: client.repo,
    head: params.head,
    base: params.base,
    title: params.title,
    body: params.body,
    draft: params.draft ?? false,
  });
  return toPullRequestRef(data as any);
}

export async function getPullRequest(client: GitHubClient, number: number): Promise<PullRequestRef> {
  const { data } = await client.octokit.pulls.get({
    owner: client.owner,
    repo: client.repo,
    pull_number: number,
  });
  return toPullRequestRef(data as any);
}
