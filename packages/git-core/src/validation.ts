import type { ValidationCheck, ValidationResult } from './types.js';

export class Checklist {
  private checks: ValidationCheck[] = [];

  add(id: string, label: string, ok: boolean, opts: { detail?: string; severity?: 'error' | 'warning' } = {}): this {
    this.checks.push({ id, label, ok, detail: opts.detail, severity: opts.severity ?? 'error' });
    return this;
  }

  result(): ValidationResult {
    const ok = this.checks.every((c) => c.ok || c.severity === 'warning');
    return { ok, checks: this.checks };
  }
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function isVersionGreater(next: string, current: string): boolean {
  return isValidSemver(next) && isValidSemver(current) && compareSemver(next, current) > 0;
}

export function formatChecklist(title: string, result: ValidationResult): string {
  const lines = [title, ''];
  for (const check of result.checks) {
    const mark = check.ok ? '✓' : check.severity === 'warning' ? '⚠' : '✗';
    lines.push(`${mark} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  lines.push('');
  lines.push(result.ok ? 'Ready.' : 'Not ready — resolve the items above.');
  return lines.join('\n');
}

/** `v1.4.0` -> `1.4.0`; anything else -> null. Production tags are the release source of truth. */
export function versionFromTag(tag: string): string | null {
  const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
  return match && isValidSemver(match[1]) ? match[1] : null;
}

export function tagForVersion(version: string): string {
  return `v${version}`;
}

/** Highest `vX.Y.Z` tag in the list, or null when none of them is a production tag. */
export function highestVersionTag(tags: string[]): string | null {
  const versions = tags
    .map((tag) => ({ tag, version: versionFromTag(tag) }))
    .filter((t): t is { tag: string; version: string } => t.version !== null);
  if (versions.length === 0) return null;
  versions.sort((a, b) => compareSemver(a.version, b.version));
  return versions[versions.length - 1].tag;
}
