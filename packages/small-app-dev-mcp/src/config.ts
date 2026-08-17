import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface AppDevConfig {
  version: number;
  project: {
    type: string;
    /** Optional — auto-detected from *.xcworkspace / *.xcodeproj when omitted. */
    path?: string;
    /** Optional — auto-detected via `xcodebuild -list` when omitted. */
    scheme?: string;
  };
  workflow: {
    production_branch: string;
    development_branch: string;
    hotfix_prefix: string;
  };
  branches: {
    direct_commit: Record<string, boolean>;
  };
  release: {
    merge_strategy: 'squash' | 'merge' | 'rebase';
    require: {
      clean_worktree: boolean;
      ci: boolean;
    };
    auto_submit_review: boolean;
    auto_publish: boolean;
  };
  hotfix: {
    base_branch: string;
    sync_back_to_release: boolean;
  };
  github: {
    require_pull_request_to_main: boolean;
    block_force_push_main: boolean;
  };
}

export const DEFAULT_CONFIG: AppDevConfig = {
  version: 1,
  project: { type: 'ios' },
  workflow: {
    production_branch: 'main',
    development_branch: 'release',
    hotfix_prefix: 'hotfix/',
  },
  branches: {
    direct_commit: { main: false, release: true },
  },
  release: {
    merge_strategy: 'squash',
    require: { clean_worktree: true, ci: true },
    auto_submit_review: false,
    auto_publish: false,
  },
  hotfix: {
    base_branch: 'main',
    sync_back_to_release: true,
  },
  github: {
    require_pull_request_to_main: true,
    block_force_push_main: true,
  },
};

export const CONFIG_FILENAME = '.appdev.yml';

export function loadConfig(projectDir: string): { config: AppDevConfig; found: boolean; path: string } {
  const path = join(projectDir, CONFIG_FILENAME);
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, found: false, path };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw) as Partial<AppDevConfig>;
  const merged = deepMerge(DEFAULT_CONFIG, parsed ?? {});
  return { config: merged, found: true, path };
}

export function serializeConfig(config: AppDevConfig): string {
  return yaml.dump(config, { lineWidth: 100 });
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== 'object' || base === null) return (override as T) ?? base;
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override ?? {})) {
    const overrideValue = (override as any)[key];
    const baseValue = (base as any)[key];
    if (
      overrideValue &&
      typeof overrideValue === 'object' &&
      !Array.isArray(overrideValue) &&
      baseValue &&
      typeof baseValue === 'object'
    ) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}
