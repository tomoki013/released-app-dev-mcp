import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MANAGED_MARKERS } from '../workflows/index.js';

export interface StepResult {
  ok: boolean;
  line: string;
}

/** Writes `content` to `relPath` unless a file already exists there that this MCP didn't generate. */
export function writeManagedFile(cwd: string, relPath: string, content: string, dryRun: boolean): StepResult {
  const targetPath = join(cwd, relPath);
  const name = relPath.split('/').pop()!;

  if (existsSync(targetPath)) {
    if (!isManagedFile(targetPath)) {
      return { ok: false, line: `Skipped existing custom ${name} (not managed by this MCP).` };
    }
    const current = readFileSync(targetPath, 'utf-8');
    if (current === content) return { ok: true, line: `${name} already configured` };
    if (!dryRun) writeFileSync(targetPath, content, 'utf-8');
    return { ok: true, line: `${name} updated` };
  }

  if (!dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }
  return { ok: true, line: `${name} created` };
}

export function isManagedFile(path: string): boolean {
  try {
    const firstLine = readFileSync(path, 'utf-8').split('\n', 1)[0];
    return MANAGED_MARKERS.includes(firstLine);
  } catch {
    return false;
  }
}

/** Appends `entry` to .gitignore when it isn't already ignored, creating the file if needed. */
export function ensureGitignoreEntry(cwd: string, entry: string, dryRun: boolean): StepResult {
  const path = join(cwd, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  if (existing.split('\n').some((line) => line.trim() === entry)) {
    return { ok: true, line: `.gitignore already ignores ${entry}` };
  }
  const next = existing && !existing.endsWith('\n') ? `${existing}\n${entry}\n` : `${existing}${entry}\n`;
  if (!dryRun) writeFileSync(path, next, 'utf-8');
  return { ok: true, line: `.gitignore updated to ignore ${entry} (local release-state cache)` };
}
