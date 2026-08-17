import type { DetectedProject } from '@app-dev/git-core';
import type { AppDevConfig } from './config.js';

/**
 * First line of every file this tool writes. setup_repository checks for
 * this to tell "safe to regenerate" apart from a hand-written file with the
 * same name — see isManagedFile() in tools/setupRepository.ts.
 */
export const MANAGED_MARKER_YAML = '# managed-by: small-app-dev-mcp (see .appdev.yml)';
export const MANAGED_MARKER_MD = '<!-- managed-by: small-app-dev-mcp (see .appdev.yml) -->';

function xcodeFlag(project: DetectedProject): string {
  return project.projectType === 'xcworkspace' ? '-workspace' : '-project';
}

export function generateCiYaml(project: DetectedProject, config: AppDevConfig): string {
  const prodBranch = config.workflow.production_branch;
  const devBranch = config.workflow.development_branch;

  return `${MANAGED_MARKER_YAML}
name: CI

# Runs on every PR into ${prodBranch} — this is what keeps broken code out
# of the production branch. A push to ${devBranch} also runs it so problems
# surface while you're still accumulating changes, not just at release time.
on:
  pull_request:
    branches:
      - ${prodBranch}
  push:
    branches:
      - ${devBranch}

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: |
          xcodebuild \\
            ${xcodeFlag(project)} ${project.projectPath} \\
            -scheme ${project.scheme} \\
            -destination 'generic/platform=iOS Simulator' \\
            build
`;
}

export function generateReleaseYaml(project: DetectedProject, config: AppDevConfig): string {
  const prodBranch = config.workflow.production_branch;
  const devBranch = config.workflow.development_branch;
  const hotfixPrefix = config.workflow.hotfix_prefix;

  return `${MANAGED_MARKER_YAML}
name: Release

# Fires only when a PR into ${prodBranch} is merged — and only handles it as a
# release when the merged branch was "${devBranch}" or a "${hotfixPrefix}*" hotfix.
# A regular PR merge (feature/*, chore/*, docs/*, ...) is NOT a release.
on:
  pull_request:
    types:
      - closed
    branches:
      - ${prodBranch}

jobs:
  release:
    if: >
      github.event.pull_request.merged == true &&
      (
        github.event.pull_request.head.ref == '${devBranch}' ||
        startsWith(github.event.pull_request.head.ref, '${hotfixPrefix}')
      )
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${prodBranch}

      - name: Build
        run: |
          xcodebuild \\
            ${xcodeFlag(project)} ${project.projectPath} \\
            -scheme ${project.scheme} \\
            -destination 'generic/platform=iOS Simulator' \\
            build

      # Confirms the app can actually be archived (code signing not required
      # here) without going any further — no export, no upload, no submit.
      # Wiring up real code signing / TestFlight upload / App Store Connect
      # submission is out of scope for this MCP; see appstore-connect-mcp.
      - name: Archive
        run: |
          xcodebuild archive \\
            ${xcodeFlag(project)} ${project.projectPath} \\
            -scheme ${project.scheme} \\
            -archivePath build/App.xcarchive \\
            CODE_SIGNING_ALLOWED=NO

      - name: Release preparation summary
        run: |
          echo "Build archived successfully. GitHub release side is ready."
          echo "Submit for review manually via App Store Connect."
`;
}

export function generatePullRequestTemplate(): string {
  return `${MANAGED_MARKER_MD}
<!--
For a release PR (release -> main), keep the auto-generated summary below.
For a hotfix PR (hotfix/* -> main), describe the bug, the fix, and how it was verified.
-->

## Summary

## Checklist

- [ ] CI passing
- [ ] Tested on a physical device
- [ ] (Hotfix only) release branch will be synced after merge
`;
}
