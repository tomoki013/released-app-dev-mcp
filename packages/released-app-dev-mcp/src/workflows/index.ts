import type { DetectedProject } from '@app-dev/git-core';
import type { AppDevConfig, StrategyName } from '../core/config.js';
import { largeWorkflows } from './large.js';
import { smallWorkflows } from './small.js';
import { generatePullRequestTemplate, type GeneratedFile } from './templates.js';

export * from './templates.js';

const WORKFLOW_SETS: Record<StrategyName, (project: DetectedProject, config: AppDevConfig) => GeneratedFile[]> = {
  small: smallWorkflows,
  large: largeWorkflows,
};

/** The workflow files a repository on `config.strategy` should have. */
export function workflowsFor(project: DetectedProject, config: AppDevConfig): GeneratedFile[] {
  const build = WORKFLOW_SETS[config.strategy];
  if (!build) throw new Error(`No workflow templates for strategy "${config.strategy}".`);
  return build(project, config);
}

/** Workflow paths that belong to a strategy — used to spot leftovers after a migration. */
export function workflowPathsFor(strategy: StrategyName): string[] {
  const stub: DetectedProject = {
    platform: 'ios',
    projectType: 'xcodeproj',
    projectPath: 'App.xcodeproj',
    scheme: 'App',
    bundleId: null,
    version: null,
    buildNumber: null,
  };
  const config = { branches: { production: 'main', development: strategy === 'large' ? 'develop' : 'release', hotfixPrefix: 'hotfix/', releasePrefix: 'release/', featurePrefix: 'feature/' } } as AppDevConfig;
  return WORKFLOW_SETS[strategy](stub, config).map((f) => f.path);
}

export { generatePullRequestTemplate };
