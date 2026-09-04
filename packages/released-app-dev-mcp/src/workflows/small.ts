import type { DetectedProject } from '@app-dev/git-core';
import type { AppDevConfig } from '../core/config.js';
import {
  archiveStep,
  buildStep,
  generateCiYaml,
  MANAGED_MARKER_YAML,
  traceabilityStep,
  type GeneratedFile,
} from './templates.js';

export function smallWorkflows(project: DetectedProject, config: AppDevConfig): GeneratedFile[] {
  const production = config.branches.production;
  const development = config.branches.development;
  const hotfixPrefix = config.branches.hotfixPrefix;

  return [
    {
      path: '.github/workflows/ci.yml',
      content: generateCiYaml(project, {
        pullRequestBranches: [production, development],
        pushBranches: [development],
      }),
    },
    {
      path: '.github/workflows/release.yml',
      content: `${MANAGED_MARKER_YAML}
name: Release

# Fires only when a PR into ${production} is merged — and only treats it as a
# release when the merged branch was "${development}" or a "${hotfixPrefix}*" hotfix.
# A regular feature PR merge is NOT a release.
on:
  pull_request:
    types:
      - closed
    branches:
      - ${production}

jobs:
  release:
    if: >
      github.event.pull_request.merged == true &&
      (
        github.event.pull_request.head.ref == '${development}' ||
        startsWith(github.event.pull_request.head.ref, '${hotfixPrefix}')
      )
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${production}

${buildStep(project)}

${archiveStep(project)}

${traceabilityStep()}

      - name: Next step
        run: |
          echo "Git side is ready. Submit via App Store Connect (appstore-connect-mcp)," >> \${GITHUB_STEP_SUMMARY}
          echo "then run finish_release once the version is live." >> \${GITHUB_STEP_SUMMARY}
`,
    },
  ];
}
