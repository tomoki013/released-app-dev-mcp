import type { ProjectContext } from '../core/context.js';
import { collectStatus } from '../core/status.js';

export async function getAppStatus(ctx: ProjectContext): Promise<string> {
  const status = await collectStatus(ctx);
  if (!status.isRepo) {
    return ['This directory is not a Git repository.', '', `Next action: ${status.nextAction}`].join('\n');
  }

  const sections: string[] = [];
  sections.push(
    [
      status.ownerRepo ? `${status.ownerRepo.owner}/${status.ownerRepo.repo}` : '(no origin remote)',
      `  Managed:   ${status.managed ? `yes (${ctx.configPath.split('/').pop()})` : 'NO — unmanaged repository'}`,
      `  Lifecycle: ${status.lifecycle}`,
      `  Strategy:  ${status.strategy}`,
    ].join('\n'),
  );

  const projectLines = ['Project'];
  if (status.project) {
    projectLines.push(`  iOS — ${status.project.projectPath}`);
    projectLines.push(`  Scheme: ${status.project.scheme ?? 'not detected'}`);
    projectLines.push(
      `  Version: ${status.project.version ?? 'not detected'}${status.project.buildNumber ? ` (build ${status.project.buildNumber})` : ''}`,
    );
  } else {
    projectLines.push('  No Xcode project detected in this directory.');
  }
  sections.push(projectLines.join('\n'));

  const tree = status.workingTree;
  const treeLine = !tree
    ? 'unknown'
    : tree.clean
      ? 'clean'
      : `dirty (${tree.staged.length + tree.modified.length + tree.notAdded.length} changed file(s))`;
  sections.push(['Git', `  Current branch: ${status.currentBranch}`, `  Working tree:   ${treeLine}`].join('\n'));

  const branchLines = ['Branches'];
  for (const entry of status.divergence) {
    if (!entry.exists) {
      branchLines.push(`  ${entry.branch}: NOT FOUND locally`);
    } else if (entry.branch === ctx.strategy.productionBranch) {
      branchLines.push(`  ${entry.branch}: production lineage`);
    } else {
      branchLines.push(
        `  ${entry.branch}: ${entry.ahead} ahead / ${entry.behind} behind "${ctx.strategy.productionBranch}"`,
      );
    }
  }
  sections.push(branchLines.join('\n'));

  sections.push(
    [
      'Production',
      `  Tag:     ${status.productionTag ?? 'none'}`,
      `  Version: ${status.productionVersion ?? 'unknown'}`,
    ].join('\n'),
  );

  const releaseLines = ['Release'];
  releaseLines.push(
    `  Active release branch: ${status.activeReleaseBranches.length ? status.activeReleaseBranches.join(', ') : 'none'}`,
  );
  const candidates = status.releaseState.candidates.map(
    (c) => `  Candidate ${c.version} — ${c.commit.slice(0, 7)} from ${c.releaseBranch} (${c.strategy})`,
  );
  releaseLines.push(...(candidates.length ? candidates : ['  Prepared candidate: none']));
  releaseLines.push(`  Open release PR: ${status.openReleasePr ?? (status.githubError ? 'unknown' : 'none')}`);
  sections.push(releaseLines.join('\n'));

  sections.push(
    [
      'Hotfix',
      status.activeHotfixBranches.length
        ? status.activeHotfixBranches.map((b) => `  ${b}`).join('\n')
        : '  none',
    ].join('\n'),
  );

  sections.push(
    [
      'CI',
      status.ci
        ? `  ${status.ci.branch}: ${status.ci.state}`
        : status.githubError
          ? `  unavailable — ${status.githubError}`
          : '  unavailable (GITHUB_TOKEN not configured)',
    ].join('\n'),
  );

  sections.push(
    [
      'Blocking issues',
      status.blockingIssues.length ? status.blockingIssues.map((i) => `  ✗ ${i}`).join('\n') : '  none',
    ].join('\n'),
  );

  sections.push(`Next action\n  ${status.nextAction}`);

  if (status.lifecycle === 'released') {
    sections.push(
      [
        'Policy',
        '  This app is released. Use this MCP for every release, hotfix, production merge and tag.',
        '  Do not run git branch/merge/tag/push by hand on the production, release or hotfix lineage.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
