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
