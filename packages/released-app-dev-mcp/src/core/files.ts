import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseManagedHeader, TEMPLATE_VERSION } from '../workflows/index.js';

export interface StepResult {
  ok: boolean;
  line: string;
}

export interface WriteManagedOptions {
  dryRun: boolean;
  /**
   * Replace a managed file whose content differs from the template. Off by
   * default: a differing file is either hand-edited or on an older template,
   * and both deserve a look at the diff before anything is lost.
   */
  overwrite?: boolean;
}

const MAX_DIFF_LINES = 60;

/**
 * Writes `content` to `relPath` unless a file already exists there that this
 * MCP didn't generate, that is marked "(customized)", or that differs from the
 * template and `overwrite` was not requested.
 */
export function writeManagedFile(cwd: string, relPath: string, content: string, opts: WriteManagedOptions): StepResult {
  const targetPath = join(cwd, relPath);
  const name = basename(relPath);

  if (!existsSync(targetPath)) {
    if (!opts.dryRun) {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content, 'utf-8');
    }
    return { ok: true, line: `${name} created` };
  }

  const current = readFileSync(targetPath, 'utf-8');
  const header = parseManagedHeader(current);
  if (!header.managed) {
    return { ok: false, line: `Skipped existing custom ${name} (not managed by this MCP).` };
  }
  if (header.customized) {
    return { ok: true, line: `${name} left as is (marked customized)` };
  }
  if (current === content) return { ok: true, line: `${name} already configured` };

  const why =
    header.templateVersion === null || header.templateVersion < TEMPLATE_VERSION
      ? `template v${header.templateVersion ?? '?'} -> v${TEMPLATE_VERSION}`
      : 'edited by hand since it was generated';

  if (opts.dryRun) {
    return {
      ok: true,
      line: [`${name} would be ${opts.overwrite ? 'overwritten' : 'kept'} (${why}):`, indent(unifiedDiff(targetPath, content))].join('\n'),
    };
  }
  if (!opts.overwrite) {
    return {
      ok: false,
      line:
        `${name} differs from the template (${why}) — kept. ` +
        'Run with dry_run: true to see the diff, then overwrite_workflows: true to regenerate, ' +
        'or change its first line to "(customized)" to keep your edits for good.',
    };
  }
  writeFileSync(targetPath, content, 'utf-8');
  return { ok: true, line: `${name} updated (${why})` };
}

export function isManagedFile(path: string): boolean {
  try {
    return parseManagedHeader(readFileSync(path, 'utf-8')).managed;
  } catch {
    return false;
  }
}

/** `git diff` between the file on disk and the content the template would write. Git is always present: this MCP cannot run without it. */
export function unifiedDiff(existingPath: string, nextContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'released-app-mcp-diff-'));
  const nextPath = join(dir, basename(existingPath));
  try {
    writeFileSync(nextPath, nextContent, 'utf-8');
    let out: string;
    try {
      out = execFileSync('git', ['diff', '--no-index', '--no-color', '--unified=2', '--', existingPath, nextPath], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: any) {
      // Exit code 1 means "files differ" — the diff is on stdout.
      out = typeof err?.stdout === 'string' ? err.stdout : '';
    }
    const body = out
      .split('\n')
      .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line))
      .filter((line, i, all) => !(i === all.length - 1 && line === ''));
    if (body.length === 0) return '(diff unavailable)';
    return body.length > MAX_DIFF_LINES
      ? [...body.slice(0, MAX_DIFF_LINES), `... ${body.length - MAX_DIFF_LINES} more line(s)`].join('\n')
      : body.join('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function indent(text: string, prefix = '      '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
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
