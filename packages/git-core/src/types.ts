export interface RepoRef {
  owner: string;
  repo: string;
}

export interface GitHubContext extends RepoRef {
  token: string;
}

export interface BranchStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
}

export interface WorkingTreeStatus {
  clean: boolean;
  staged: string[];
  modified: string[];
  notAdded: string[];
  conflicted: string[];
}

export interface CommitSummary {
  hash: string;
  message: string;
  authorName: string;
  date: string;
}

export type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

export interface CombinedCiStatus {
  state: 'success' | 'failure' | 'pending' | 'error' | 'unknown';
  totalCount: number;
  checks: Array<{
    name: string;
    status: string;
    conclusion: CheckRunConclusion;
    detailsUrl: string | null;
  }>;
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  event: string;
  url: string;
  createdAt: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  severity: 'error' | 'warning';
}

/** Result of an in-memory merge probe — no refs or working tree touched. */
export interface MergePreview {
  state: 'clean' | 'conflict' | 'up-to-date' | 'unknown';
  conflictingFiles: string[];
}
