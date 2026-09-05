import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StrategyName } from './config.js';

export const STATE_FILENAME = '.app-dev-mcp.state.json';

/** A release that has been prepared in Git but is not yet live on the App Store. */
export interface ReleaseCandidateRecord {
  version: string;
  build: string | null;
  commit: string;
  strategy: StrategyName;
  sourceBranch: string;
  releaseBranch: string;
  createdAt: string;
}

/** A release that actually shipped — the Git side is closed out with a production tag. */
export interface PublishedReleaseRecord {
  version: string;
  tag: string;
  build: string | null;
  commit: string;
  strategy: StrategyName;
  sourceBranch: string;
  publishedAt: string;
}

export interface ReleaseState {
  schemaVersion: 1;
  candidates: ReleaseCandidateRecord[];
  published: PublishedReleaseRecord[];
}

export function emptyState(): ReleaseState {
  return { schemaVersion: 1, candidates: [], published: [] };
}

export function loadState(projectDir: string): ReleaseState {
  const path = join(projectDir, STATE_FILENAME);
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      schemaVersion: 1,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      published: Array.isArray(parsed.published) ? parsed.published : [],
    };
  } catch {
    return emptyState();
  }
}

export function saveState(projectDir: string, state: ReleaseState): string {
  const path = join(projectDir, STATE_FILENAME);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return path;
}

/** One candidate per version — re-preparing the same version replaces the old record. */
export function recordCandidate(projectDir: string, record: ReleaseCandidateRecord): void {
  const state = loadState(projectDir);
  state.candidates = state.candidates.filter((c) => c.version !== record.version);
  state.candidates.push(record);
  saveState(projectDir, state);
}

export function recordPublished(projectDir: string, record: PublishedReleaseRecord): void {
  const state = loadState(projectDir);
  state.candidates = state.candidates.filter((c) => c.version !== record.version);
  state.published = state.published.filter((p) => p.version !== record.version);
  state.published.push(record);
  saveState(projectDir, state);
}

export function findCandidate(state: ReleaseState, version: string): ReleaseCandidateRecord | null {
  return state.candidates.find((c) => c.version === version) ?? null;
}

export function latestPublished(state: ReleaseState): PublishedReleaseRecord | null {
  if (state.published.length === 0) return null;
  return [...state.published].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1) ?? null;
}
