import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const execFileAsync = promisify(execFile);

export type ProjectGenerator = 'xcodegen' | 'tuist';

export interface DetectedProject {
  platform: 'ios';
  projectType: 'xcworkspace' | 'xcodeproj';
  projectPath: string;
  scheme: string | null;
  bundleId: string | null;
  version: string | null;
  buildNumber: string | null;
  /** Tool that produces the .xcodeproj from a spec file, when the project is generated rather than committed. */
  generator: ProjectGenerator | null;
}

const GENERATOR_SPECS: Array<{ generator: ProjectGenerator; file: string; namePattern: RegExp }> = [
  { generator: 'xcodegen', file: 'project.yml', namePattern: /^name:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m },
  { generator: 'tuist', file: 'Project.swift', namePattern: /name:\s*"([^"]+)"/ },
];

export interface DetectProjectOverrides {
  /** From .appdev.yml `project.path` — takes priority over auto-detected project file. */
  path?: string;
  /** From .appdev.yml `project.scheme` — takes priority over auto-picked scheme. */
  scheme?: string;
}

/**
 * Best-effort detection of the iOS project in `cwd`. Never throws — a probe
 * that fails (no Xcode, no scheme, sandboxed `xcodebuild`, ...) just leaves
 * that field `null` so callers can fall back to config or ask the user.
 *
 * `.appdev.yml` values always win: pass them as `overrides` and they're used
 * as-is instead of the auto-detected path/scheme.
 */
export async function detectProject(
  cwd: string,
  overrides: DetectProjectOverrides = {},
): Promise<DetectedProject | null> {
  const generated = findGeneratedProject(cwd);
  // A generated .xcodeproj is usually gitignored, so the spec file is the only
  // thing on disk in a fresh checkout — fall back to the name it declares.
  const projectFile = overrides.path
    ? fileFromPath(overrides.path)
    : (findProjectFile(cwd) ?? (generated?.name ? fileFromPath(`${generated.name}.xcodeproj`) : null));
  if (!projectFile) return null;

  const project: DetectedProject = {
    platform: 'ios',
    projectType: projectFile.type,
    projectPath: projectFile.name,
    scheme: null,
    bundleId: null,
    version: null,
    buildNumber: null,
    generator: generated?.generator ?? null,
  };

  if (overrides.scheme) {
    project.scheme = overrides.scheme;
  } else {
    const schemes = await listSchemes(cwd, projectFile);
    project.scheme = pickScheme(schemes, projectFile.name);
    // Without the generated project on disk there is nothing to list; the
    // generator names the scheme after the project, so that is the best guess.
    if (!project.scheme && project.generator) {
      project.scheme = basename(projectFile.name).replace(/\.(xcworkspace|xcodeproj)$/, '');
    }
  }

  if (project.scheme) {
    const settings = await getBuildSettings(cwd, projectFile, project.scheme);
    if (settings) {
      project.bundleId = settings.PRODUCT_BUNDLE_IDENTIFIER ?? null;
      project.version = settings.MARKETING_VERSION ?? null;
      project.buildNumber = settings.CURRENT_PROJECT_VERSION ?? null;
    }
  }

  return project;
}

/** The project generator in use (XcodeGen / Tuist) and the project name its spec declares, if any. */
export function findGeneratedProject(cwd: string): { generator: ProjectGenerator; name: string | null } | null {
  for (const spec of GENERATOR_SPECS) {
    const specPath = join(cwd, spec.file);
    if (!existsSync(specPath)) continue;
    let name: string | null = null;
    try {
      name = readFileSync(specPath, 'utf-8').match(spec.namePattern)?.[1]?.trim() ?? null;
    } catch {
      name = null;
    }
    return { generator: spec.generator, name };
  }
  return null;
}

function fileFromPath(path: string): { type: 'xcworkspace' | 'xcodeproj'; name: string } | null {
  if (path.endsWith('.xcworkspace')) return { type: 'xcworkspace', name: path };
  if (path.endsWith('.xcodeproj')) return { type: 'xcodeproj', name: path };
  return null;
}

function findProjectFile(cwd: string): { type: 'xcworkspace' | 'xcodeproj'; name: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }

  // Ignore Xcode's own auto-generated workspace inside an .xcodeproj (e.g.
  // "MyApp.xcodeproj/project.xcworkspace") — only top-level files count.
  const workspace = entries.find((e) => e.endsWith('.xcworkspace'));
  if (workspace) return { type: 'xcworkspace', name: workspace };

  const project = entries.find((e) => e.endsWith('.xcodeproj'));
  if (project) return { type: 'xcodeproj', name: project };

  return null;
}

async function listSchemes(
  cwd: string,
  projectFile: { type: 'xcworkspace' | 'xcodeproj'; name: string },
): Promise<string[]> {
  const flag = projectFile.type === 'xcworkspace' ? '-workspace' : '-project';
  try {
    const { stdout } = await execFileAsync('xcodebuild', ['-list', '-json', flag, projectFile.name], {
      cwd,
      timeout: 15_000,
    });
    const parsed = JSON.parse(stdout);
    const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    return Array.isArray(schemes) ? schemes : [];
  } catch {
    return [];
  }
}

/** Prefers a scheme matching the project/workspace name, then the app-like heuristic, then the first scheme. */
function pickScheme(schemes: string[], projectFileName: string): string | null {
  if (schemes.length === 0) return null;
  if (schemes.length === 1) return schemes[0];

  const stem = basename(projectFileName).replace(/\.(xcworkspace|xcodeproj)$/, '');
  const exact = schemes.find((s) => s === stem);
  if (exact) return exact;

  const caseInsensitive = schemes.find((s) => s.toLowerCase() === stem.toLowerCase());
  if (caseInsensitive) return caseInsensitive;

  return schemes[0];
}

async function getBuildSettings(
  cwd: string,
  projectFile: { type: 'xcworkspace' | 'xcodeproj'; name: string },
  scheme: string,
): Promise<Record<string, string> | null> {
  const flag = projectFile.type === 'xcworkspace' ? '-workspace' : '-project';
  try {
    const { stdout } = await execFileAsync(
      'xcodebuild',
      ['-showBuildSettings', flag, projectFile.name, '-scheme', scheme, '-json'],
      { cwd, timeout: 20_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const settings = parsed?.[0]?.buildSettings;
    return settings && typeof settings === 'object' ? settings : null;
  } catch {
    return null;
  }
}
