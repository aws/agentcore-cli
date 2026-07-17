import { CliVersionTooOldError, DependencySyncError } from '../errors/types';
import { runSubprocessCapture } from '../utils/subprocess';
import {
  DEFAULT_CLI_INSTALL_COMMAND,
  formatCliUpgradeError,
  formatSkewWarning,
  formatSkippedWarning,
  formatSyncNotice,
} from './messages';
import { computeSyncPlan } from './policy';
import type { DependencySyncResult, PackageManifest, SyncManagedDependenciesOptions } from './types';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type {
  DependencyChange,
  DependencySyncResult,
  RestoredDependency,
  SkippedDependency,
  SyncManagedDependenciesOptions,
} from './types';

async function readManifest(path: string, what: string): Promise<PackageManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new DependencySyncError(`Could not read ${what} at ${path}: ${String(err)}`, { cause: err });
  }
  try {
    return JSON.parse(raw) as PackageManifest;
  } catch (err) {
    throw new DependencySyncError(`Could not parse ${what} at ${path}: ${String(err)}`, { cause: err });
  }
}

/**
 * Sync the managed dependencies of a vended CDK project to the versions this CLI
 * release was tested with (agentcore-cli#1540).
 *
 * The vended asset package.json is the source of truth: every dependency named in it
 * is managed and rewritten to its vended specifier (tilde for stable deps so patches
 * float, exact for the L3 constructs); everything else in the user's file is untouched.
 * Projects that predate pinning (caret ranges) are migrated automatically. If the
 * project declares a managed dependency newer than this CLI expects, the project was
 * updated by a newer CLI (or the user bumped it manually) and this throws
 * CliVersionTooOldError (downgraded to a warning when `disabled` or
 * `treatSkewAsWarning`). When anything changed — or node_modules is missing, e.g. a
 * previous install failed midway — `npm install` reconciles the edited package.json
 * against the existing lockfile incrementally; node_modules and the lockfile are
 * never deleted, so user-added deps keep their resolved versions.
 *
 * `mode: 'check'` computes the same plan/warnings/notice without writing or
 * installing, for preview flows that must not mutate the working tree.
 *
 * All user-facing wording is returned on the result (`notice`, `warnings`) — callers
 * only display it. Throws CliVersionTooOldError | DependencySyncError; never exits.
 */
export async function syncManagedDependencies(options: SyncManagedDependenciesOptions): Promise<DependencySyncResult> {
  const {
    vendedPackageJsonPath,
    projectDir,
    disabled = false,
    mode = 'apply',
    treatSkewAsWarning = false,
    installCommand = DEFAULT_CLI_INSTALL_COMMAND,
  } = options;
  const checkOnly = mode === 'check';
  const projectPackageJsonPath = join(projectDir, 'package.json');

  const vended = await readManifest(vendedPackageJsonPath, 'the vended CDK package.json');
  const project = await readManifest(projectPackageJsonPath, "the project's CDK package.json");

  const plan = computeSyncPlan(vended, project);

  const result: DependencySyncResult = {
    optedOut: disabled,
    checkOnly,
    migrated: plan.migratedFromCaret,
    reinstalled: false,
    skewWarning: false,
    changes: plan.changes,
    restored: plan.restored,
    skipped: plan.skipped,
    warnings: plan.skipped.map(formatSkippedWarning),
    notice: null,
  };

  if (plan.skew.length > 0) {
    if (!disabled && !treatSkewAsWarning && !checkOnly) {
      throw new CliVersionTooOldError(formatCliUpgradeError(plan.skew, installCommand));
    }
    result.skewWarning = true;
    result.warnings.push(formatSkewWarning(plan.skew, installCommand));
  }

  if (disabled) {
    return result;
  }

  const hasPlannedChanges = plan.changes.length > 0 || plan.restored.length > 0;

  if (checkOnly) {
    // Report what WOULD change without touching the working tree (future-tense wording).
    result.notice = formatSyncNotice({
      migrated: result.migrated,
      changes: result.changes,
      restored: result.restored,
      reinstalled: false,
      applied: false,
    });
    return result;
  }

  if (hasPlannedChanges) {
    // Mutate the parsed manifest in place so user key order and unknown fields survive.
    for (const change of plan.changes) {
      project[change.section]![change.name] = change.to;
    }
    for (const restoredDep of plan.restored) {
      const section = (project[restoredDep.section] ??= {});
      section[restoredDep.name] = restoredDep.to;
    }

    try {
      await writeFile(projectPackageJsonPath, JSON.stringify(project, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new DependencySyncError(`Failed to update the CDK project's dependencies: ${String(err)}`, { cause: err });
    }
  }

  // Install when the manifest changed OR node_modules is missing (a previous failed install —
  // package.json already matched on retry — self-heals here). npm >=7 reconciles the edited
  // package.json against the existing lockfile incrementally, so we never delete node_modules
  // or the lockfile: user-added deps keep their resolved versions and installs stay warm.
  const needsInstall = hasPlannedChanges || !existsSync(join(projectDir, 'node_modules'));
  if (!needsInstall) {
    return result;
  }

  const install = await runSubprocessCapture('npm', ['install'], { cwd: projectDir });
  if (install.code !== 0) {
    throw new DependencySyncError(
      `npm install failed after updating managed dependencies (exit ${String(install.code)}): ${install.stderr}`
    );
  }
  result.reinstalled = true;

  result.notice = formatSyncNotice({
    migrated: result.migrated,
    changes: result.changes,
    restored: result.restored,
    reinstalled: result.reinstalled,
    applied: true,
  });
  return result;
}
