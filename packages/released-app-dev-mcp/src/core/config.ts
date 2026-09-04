import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export type StrategyName = 'small' | 'large';
export type Lifecycle = 'development' | 'released';

export interface AppDevConfig {
  schemaVersion: 1;
  /** "released" = published to the App Store at least once; this MCP is then mandatory for release Git. */
  lifecycle: Lifecycle;
  strategy: StrategyName;
  platform: 'ios';
  project: {
    /** Optional — auto-detected from *.xcworkspace / *.xcodeproj when omitted. */
    path?: string;
    /** Optional — auto-detected via `xcodebuild -list` when omitted. */
    scheme?: string;
  };
  branches: {
    production: string;
    /** Where feature branches land: "release" (small) or "develop" (large). */
    development: string;
    hotfixPrefix: string;
    releasePrefix: string;
    featurePrefix: string;
  };
  release: {
    mergeStrategy: 'merge' | 'squash' | 'rebase';
    requireCleanWorktree: boolean;
    requireCi: boolean;
  };
  hotfix: {
    /** Always the production lineage — kept explicit so a misconfiguration is visible, not implicit. */
    source: string;
  };
  github: {
    requirePullRequestToProduction: boolean;
    blockForcePushProduction: boolean;
  };
}

export const CONFIG_FILENAME = '.app-dev-mcp.json';
export const LEGACY_CONFIG_FILENAME = '.appdev.yml';

const SMALL_BRANCHES = {
  production: 'main',
  development: 'release',
  hotfixPrefix: 'hotfix/',
  releasePrefix: 'release/',
  featurePrefix: 'feature/',
};

const LARGE_BRANCHES = { ...SMALL_BRANCHES, development: 'develop' };

export function defaultConfig(strategy: StrategyName, lifecycle: Lifecycle = 'released'): AppDevConfig {
  return {
    schemaVersion: 1,
    lifecycle,
    strategy,
    platform: 'ios',
    project: {},
    branches: { ...(strategy === 'large' ? LARGE_BRANCHES : SMALL_BRANCHES) },
    release: { mergeStrategy: 'merge', requireCleanWorktree: true, requireCi: true },
    hotfix: { source: 'main' },
    github: { requirePullRequestToProduction: true, blockForcePushProduction: true },
  };
}

export interface LoadedConfig {
  config: AppDevConfig;
  /** False when no config file exists — the repository is "unmanaged". */
  found: boolean;
  path: string;
  /** True when the values came from a legacy `.appdev.yml` rather than `.app-dev-mcp.json`. */
  fromLegacy: boolean;
  /** Problems that made us fall back to defaults, e.g. an unknown strategy value. */
  errors: string[];
}

export function loadConfig(projectDir: string): LoadedConfig {
  const path = join(projectDir, CONFIG_FILENAME);
  if (existsSync(path)) {
    return parseJsonConfig(path);
  }

  const legacyPath = join(projectDir, LEGACY_CONFIG_FILENAME);
  if (existsSync(legacyPath)) {
    return parseLegacyConfig(legacyPath);
  }

  return { config: defaultConfig('small'), found: false, path, fromLegacy: false, errors: [] };
}

export function saveConfig(projectDir: string, config: AppDevConfig): string {
  const path = join(projectDir, CONFIG_FILENAME);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return path;
}

export function isStrategyName(value: unknown): value is StrategyName {
  return value === 'small' || value === 'large';
}

function parseJsonConfig(path: string): LoadedConfig {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    return {
      config: defaultConfig('small'),
      found: true,
      path,
      fromLegacy: false,
      errors: [`${CONFIG_FILENAME} is not valid JSON — ${err.message}`],
    };
  }

  const parsed = (raw ?? {}) as Partial<AppDevConfig>;
  let strategy: StrategyName = 'small';
  if (isStrategyName(parsed.strategy)) {
    strategy = parsed.strategy;
  } else {
    errors.push(`"strategy" must be "small" or "large" (got ${JSON.stringify(parsed.strategy)}) — assuming "small"`);
  }

  const lifecycle: Lifecycle = parsed.lifecycle === 'development' ? 'development' : 'released';
  if (parsed.lifecycle !== 'development' && parsed.lifecycle !== 'released') {
    errors.push(`"lifecycle" must be "development" or "released" — assuming "released"`);
  }

  const merged = deepMerge(defaultConfig(strategy, lifecycle), parsed);
  merged.strategy = strategy;
  merged.lifecycle = lifecycle;
  return { config: merged, found: true, path, fromLegacy: false, errors };
}

/**
 * Reads a v1 `.appdev.yml` from the Small-only era. Those repositories are all
 * small-strategy by definition, so the mapping is mechanical — it exists so
 * `get_app_status` still works before `setup_repository` writes the new file.
 */
function parseLegacyConfig(path: string): LoadedConfig {
  const config = defaultConfig('small');
  try {
    const legacy = (yaml.load(readFileSync(path, 'utf-8')) ?? {}) as any;
    if (legacy.project?.path) config.project.path = legacy.project.path;
    if (legacy.project?.scheme) config.project.scheme = legacy.project.scheme;
    if (legacy.workflow?.production_branch) config.branches.production = legacy.workflow.production_branch;
    if (legacy.workflow?.development_branch) config.branches.development = legacy.workflow.development_branch;
    if (legacy.workflow?.hotfix_prefix) config.branches.hotfixPrefix = legacy.workflow.hotfix_prefix;
    if (legacy.hotfix?.base_branch) config.hotfix.source = legacy.hotfix.base_branch;
    if (typeof legacy.release?.require?.clean_worktree === 'boolean') {
      config.release.requireCleanWorktree = legacy.release.require.clean_worktree;
    }
    if (typeof legacy.release?.require?.ci === 'boolean') config.release.requireCi = legacy.release.require.ci;
    return { config, found: true, path, fromLegacy: true, errors: [] };
  } catch (err: any) {
    return {
      config,
      found: true,
      path,
      fromLegacy: true,
      errors: [`${LEGACY_CONFIG_FILENAME} could not be parsed — ${err.message}`],
    };
  }
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== 'object' || base === null) return (override as T) ?? base;
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override ?? {})) {
    const overrideValue = (override as any)[key];
    if (overrideValue === undefined) continue;
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
