import type { DetectedProject } from '@app-dev/git-core';

/**
 * First line of every file this MCP writes. setup_repository checks for one of
 * these to tell "safe to regenerate" apart from a hand-written file with the
 * same name. The small-app-dev-mcp markers stay recognised so repositories set
 * up by the previous version keep upgrading cleanly instead of being skipped.
 */
export const MANAGED_MARKER_YAML = '# managed-by: released-app-dev-mcp (see .app-dev-mcp.json)';
export const MANAGED_MARKER_MD = '<!-- managed-by: released-app-dev-mcp (see .app-dev-mcp.json) -->';
export const LEGACY_MARKER_YAML = '# managed-by: small-app-dev-mcp (see .appdev.yml)';
export const LEGACY_MARKER_MD = '<!-- managed-by: small-app-dev-mcp (see .appdev.yml) -->';

export const MANAGED_MARKERS = [MANAGED_MARKER_YAML, MANAGED_MARKER_MD, LEGACY_MARKER_YAML, LEGACY_MARKER_MD];

export interface GeneratedFile {
  path: string;
  content: string;
}

export function xcodeFlag(project: DetectedProject): string {
  return project.projectType === 'xcworkspace' ? '-workspace' : '-project';
}

export function buildStep(project: DetectedProject, indent = '      '): string {
  return [
    `${indent}- name: Build`,
    `${indent}  run: |`,
    `${indent}    xcodebuild \\`,
    `${indent}      ${xcodeFlag(project)} ${project.projectPath} \\`,
    `${indent}      -scheme ${project.scheme} \\`,
    `${indent}      -destination 'generic/platform=iOS Simulator' \\`,
    `${indent}      build`,
  ].join('\n');
}

/**
 * Archives without code signing: it proves the app can be archived without
 * pulling signing certificates into CI. Real signing, TestFlight upload and
 * App Store submission are appstore-connect-mcp's job, not this MCP's.
 */
export function archiveStep(project: DetectedProject, indent = '      '): string {
  return [
    `${indent}- name: Archive`,
    `${indent}  run: |`,
    `${indent}    xcodebuild archive \\`,
    `${indent}      ${xcodeFlag(project)} ${project.projectPath} \\`,
    `${indent}      -scheme ${project.scheme} \\`,
    `${indent}      -archivePath build/App.xcarchive \\`,
    `${indent}      CODE_SIGNING_ALLOWED=NO`,
  ].join('\n');
}

export function traceabilityStep(indent = '      '): string {
  return [
    `${indent}- name: Record build traceability`,
    `${indent}  run: |`,
    `${indent}    echo "Commit:  \${GITHUB_SHA}" >> \${GITHUB_STEP_SUMMARY}`,
    `${indent}    echo "Branch:  \${GITHUB_REF_NAME}" >> \${GITHUB_STEP_SUMMARY}`,
    `${indent}    echo "Run:     \${GITHUB_SERVER_URL}/\${GITHUB_REPOSITORY}/actions/runs/\${GITHUB_RUN_ID}" >> \${GITHUB_STEP_SUMMARY}`,
  ].join('\n');
}

export function branchList(branches: string[], indent = '      '): string {
  return branches.map((b) => `${indent}- ${b}`).join('\n');
}

/** CI is identical in shape for both strategies — only the branch lists differ. */
export function generateCiYaml(
  project: DetectedProject,
  opts: { pullRequestBranches: string[]; pushBranches: string[] },
): string {
  return `${MANAGED_MARKER_YAML}
name: CI

# Runs on every PR into a protected branch — this is what keeps broken code
# out of the production lineage — and on pushes to the development branch so
# problems surface while changes accumulate, not only at release time.
on:
  pull_request:
    branches:
${branchList(opts.pullRequestBranches)}
  push:
    branches:
${branchList(opts.pushBranches)}

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

${buildStep(project)}
`;
}

export function generatePullRequestTemplate(): string {
  return `${MANAGED_MARKER_MD}
<!--
Release PR  -> keep the auto-generated summary below (created by create_release_pr).
Hotfix PR   -> describe the bug, the fix, and how it was verified.
Feature PR  -> target the development branch, never the production branch.
-->

## Summary

## Checklist

- [ ] CI passing
- [ ] Tested on a physical device
- [ ] (Release/Hotfix) finish_release / finish_hotfix will be run after the App Store release is live
`;
}
