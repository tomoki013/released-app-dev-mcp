import type { DetectedProject } from '@app-dev/git-core';

/**
 * Bump whenever the generated content changes shape. It is written as the
 * second line of every managed file, so doctor can tell "the template moved
 * on" (older number) apart from "someone edited this file" (same number).
 */
export const TEMPLATE_VERSION = 2;

/**
 * First line of every file this MCP writes. setup_repository checks for one of
 * these to tell "safe to regenerate" apart from a hand-written file with the
 * same name. The small-app-dev-mcp markers stay recognised so repositories set
 * up by the previous version keep upgrading cleanly instead of being skipped.
 *
 * Replace the parenthesised part with "(customized)" to keep hand edits: the
 * file is still recognised as ours, but never regenerated.
 */
export const MANAGED_MARKER_YAML = '# managed-by: released-app-dev-mcp (see .app-dev-mcp.json)';
export const MANAGED_MARKER_MD = '<!-- managed-by: released-app-dev-mcp (see .app-dev-mcp.json) -->';
export const LEGACY_MARKER_YAML = '# managed-by: small-app-dev-mcp (see .appdev.yml)';
export const LEGACY_MARKER_MD = '<!-- managed-by: small-app-dev-mcp (see .appdev.yml) -->';

export const MANAGED_MARKERS = [MANAGED_MARKER_YAML, MANAGED_MARKER_MD, LEGACY_MARKER_YAML, LEGACY_MARKER_MD];

const MANAGED_MARKER_RE = /^(#|<!--) managed-by: (released|small)-app-dev-mcp\b/;
const CUSTOMIZED_RE = /\(customized\)/i;
const TEMPLATE_VERSION_RE = /template-version:\s*(\d+)/;

export const TEMPLATE_VERSION_YAML = `# template-version: ${TEMPLATE_VERSION}`;
export const TEMPLATE_VERSION_MD = `<!-- template-version: ${TEMPLATE_VERSION} -->`;

export interface ManagedHeader {
  managed: boolean;
  customized: boolean;
  /** Missing on files written before versioning existed. */
  templateVersion: number | null;
}

export function parseManagedHeader(content: string): ManagedHeader {
  const [first = '', second = ''] = content.split('\n', 2);
  if (!MANAGED_MARKER_RE.test(first)) return { managed: false, customized: false, templateVersion: null };
  const version = second.match(TEMPLATE_VERSION_RE);
  return {
    managed: true,
    customized: CUSTOMIZED_RE.test(first),
    templateVersion: version ? parseInt(version[1], 10) : null,
  };
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export function xcodeFlag(project: DetectedProject): string {
  return project.projectType === 'xcworkspace' ? '-workspace' : '-project';
}

/**
 * Checkout plus everything `xcodebuild` needs before it can run: a pinned
 * Xcode, and — for XcodeGen/Tuist repositories, where the .xcodeproj is not
 * committed — the SPM cache and the generate step. Without the generate step
 * every workflow fails in seconds with "<App>.xcodeproj does not exist".
 */
export function checkoutSteps(project: DetectedProject, opts: { ref?: string } = {}, indent = '      '): string {
  const lines = [`${indent}- uses: actions/checkout@v4`];
  if (opts.ref) lines.push(`${indent}  with:`, `${indent}    ref: ${opts.ref}`);
  lines.push(
    '',
    `${indent}- name: Select Xcode`,
    `${indent}  uses: maxim-lobanov/setup-xcode@v1`,
    `${indent}  with:`,
    `${indent}    xcode-version: latest-stable`,
  );
  if (project.generator) {
    lines.push(
      '',
      `${indent}- name: Cache Swift packages`,
      `${indent}  uses: actions/cache@v4`,
      `${indent}  with:`,
      `${indent}    path: |`,
      `${indent}      ~/Library/Developer/Xcode/DerivedData/**/SourcePackages`,
      `${indent}      ~/Library/Caches/org.swift.swiftpm`,
      `${indent}    key: \${{ runner.os }}-spm-\${{ hashFiles('**/Package.resolved') }}`,
      `${indent}    restore-keys: |`,
      `${indent}      \${{ runner.os }}-spm-`,
      '',
      ...generateProjectSteps(project.generator, indent),
    );
  }
  return lines.join('\n');
}

function generateProjectSteps(generator: NonNullable<DetectedProject['generator']>, indent: string): string[] {
  switch (generator) {
    case 'xcodegen':
      return [
        `${indent}- name: Install XcodeGen`,
        `${indent}  run: brew install xcodegen`,
        '',
        `${indent}- name: Generate Xcode project`,
        `${indent}  run: xcodegen generate`,
      ];
    case 'tuist':
      return [
        `${indent}- name: Install Tuist`,
        `${indent}  run: brew tap tuist/tuist && brew install --formula tuist`,
        '',
        `${indent}- name: Generate Xcode project`,
        `${indent}  run: tuist install && tuist generate --no-open`,
      ];
  }
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
${TEMPLATE_VERSION_YAML}
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
${checkoutSteps(project)}

${buildStep(project)}
`;
}

export function generatePullRequestTemplate(): string {
  return `${MANAGED_MARKER_MD}
${TEMPLATE_VERSION_MD}
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
