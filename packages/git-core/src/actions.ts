import type { GitHubClient } from './github.js';
import type { CombinedCiStatus, WorkflowRunSummary } from './types.js';

/** Combined status of the latest commit's check runs (what GitHub shows as the PR's CI status). */
export async function getCombinedCiStatus(client: GitHubClient, ref: string): Promise<CombinedCiStatus> {
  const { data } = await client.octokit.checks.listForRef({
    owner: client.owner,
    repo: client.repo,
    ref,
  });

  if (data.total_count === 0) {
    return { state: 'unknown', totalCount: 0, checks: [] };
  }

  const checks = data.check_runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion as CombinedCiStatus['checks'][number]['conclusion'],
    detailsUrl: run.details_url ?? null,
  }));

  const pending = checks.some((c) => c.status !== 'completed');
  const anyFailure = checks.some(
    (c) => c.conclusion && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion),
  );

  let state: CombinedCiStatus['state'] = 'success';
  if (pending) state = 'pending';
  else if (anyFailure) state = 'failure';

  return { state, totalCount: data.total_count, checks };
}

export async function listWorkflowRuns(
  client: GitHubClient,
  params: { branch?: string; event?: string; perPage?: number } = {},
): Promise<WorkflowRunSummary[]> {
  const { data } = await client.octokit.actions.listWorkflowRunsForRepo({
    owner: client.owner,
    repo: client.repo,
    branch: params.branch,
    event: params.event,
    per_page: params.perPage ?? 10,
  });

  return data.workflow_runs.map((run) => ({
    id: run.id,
    name: run.name ?? '',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion,
    headBranch: run.head_branch ?? '',
    event: run.event,
    url: run.html_url,
    createdAt: run.created_at,
  }));
}
