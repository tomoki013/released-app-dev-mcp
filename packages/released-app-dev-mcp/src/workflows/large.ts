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

/**
 * Large keeps develop, release/* and main on separate workflows so the three
 * responsibilities never blur: develop = internal builds, release/* = the
 * candidate under verification, main = the shipped lineage.
 */
export function largeWorkflows(project: DetectedProject, config: AppDevConfig): GeneratedFile[] {
  const production = config.branches.production;
  const development = config.branches.development;
  const releasePrefix = config.branches.releasePrefix;
  const hotfixPrefix = config.branches.hotfixPrefix;
  const releaseGlob = `'${releasePrefix}*'`;

  return [
    {
      path: '.github/workflows/ci.yml',
      content: generateCiYaml(project, {
        pullRequestBranches: [production, development, releaseGlob],
        pushBranches: [development],
      }),
    },
    {
      path: '.github/workflows/internal-testflight.yml',
      content: `${MANAGED_MARKER_YAML}
name: Internal Build

# Every push to ${development} produces an internal build. This is the fast
# feedback loop for feature work; it never touches the production lineage.
on:
  push:
    branches:
      - ${development}

jobs:
  internal:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

${buildStep(project)}

${archiveStep(project)}

${traceabilityStep()}
`,
    },
    {
      path: '.github/workflows/release-candidate.yml',
      content: `${MANAGED_MARKER_YAML}
name: Release Candidate

# Builds the frozen candidate on ${releasePrefix}X.Y.Z. Only fixes belong on this
# branch — new features go to ${development} and ship in the next release.
on:
  push:
    branches:
      - ${releaseGlob}

jobs:
  candidate:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

${buildStep(project)}

${archiveStep(project)}

${traceabilityStep()}

      - name: Next step
        run: |
          echo "Candidate built from \${GITHUB_REF_NAME}." >> \${GITHUB_STEP_SUMMARY}
          echo "Upload/submit via App Store Connect (appstore-connect-mcp)." >> \${GITHUB_STEP_SUMMARY}
`,
    },
    {
      path: '.github/workflows/production.yml',
      content: `${MANAGED_MARKER_YAML}
name: Production

# Fires only when a release candidate or hotfix PR is merged into ${production}.
on:
  pull_request:
    types:
      - closed
    branches:
      - ${production}

jobs:
  production:
    if: >
      github.event.pull_request.merged == true &&
      (
        startsWith(github.event.pull_request.head.ref, '${releasePrefix}') ||
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
          echo "Run finish_release once the version is live on the App Store" >> \${GITHUB_STEP_SUMMARY}
          echo "so the production tag and develop sync are recorded." >> \${GITHUB_STEP_SUMMARY}
`,
    },
  ];
}
