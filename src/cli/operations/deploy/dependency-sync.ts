import { syncManagedDependencies } from '../../../lib/dependency-management';
import type { DependencySyncOutcome, DependencySyncResult } from '../../../lib/dependency-management';
import { readGlobalConfigSync } from '../../../lib/schemas/io/global-config';
import type { LocalCdkProject } from '../../cdk/local-cdk-project';
import { getDistroConfig } from '../../constants';
import { getTemplatePath } from '../../templates/templateRoot';

/** Step label for the managed-dependency sync, shared by the CLI and TUI deploy flows. */
export const SYNC_CDK_DEPENDENCIES_STEP = 'Sync CDK dependencies';

export interface EnsureManagedDependenciesOptions {
  /**
   * Check-only run for preview modes (--dry-run / --diff): computes the plan, warnings, and a
   * future-tense notice without writing package.json or running npm install.
   */
  checkOnly?: boolean;
  /**
   * Teardown deploys: newer-than-CLI skew becomes a warning instead of CliVersionTooOldError,
   * so skew never blocks destroying a cost-incurring stack.
   */
  treatSkewAsWarning?: boolean;
}

/**
 * A DependencySyncResult in which no dependency operation took effect: nothing was
 * written or installed. `outcome` says why the sync was a no-op. Base shape for the
 * no-op states below.
 */
function noOpSyncResult(outcome: DependencySyncOutcome, warnings: string[] = []): DependencySyncResult {
  return {
    outcome,
    optedOut: false,
    checkOnly: false,
    migratedFromCaret: false,
    reinstalled: false,
    skewWarning: false,
    changes: [],
    restored: [],
    skipped: [],
    warnings,
    notice: null,
  };
}

/**
 * Minimal result attached to the failure path when the sync itself throws
 * (CliVersionTooOldError, or DependencySyncError on a non-teardown deploy): nothing
 * took effect, and dep_sync_* telemetry records that the sync was the failure.
 * No warning line is added — the thrown error already carries the message.
 */
export function failedSyncResult(): DependencySyncResult {
  return noOpSyncResult('failed');
}

/**
 * Warning-only result for a DependencySyncError caught on a teardown deploy. Teardown must
 * never be blocked by pinning: skew is already downgraded via `treatSkewAsWarning`, and this
 * extends the same invariant to write/install failures (broken npm env, registry outage) —
 * the failure is surfaced through the normal warnings channel and the teardown proceeds. If
 * node_modules is genuinely unusable, the build step fails on its own.
 */
export function teardownSyncFailureResult(err: Error): DependencySyncResult {
  return noOpSyncResult('failure-suppressed', [`Dependency sync failed (continuing with teardown): ${err.message}`]);
}

/**
 * Map a dependency sync result to its dep_sync_* telemetry attrs.
 * Single source for both the CLI command (command.tsx) and the TUI flow (useDeployFlow).
 */
export function toDepSyncAttrs(sync: DependencySyncResult) {
  return {
    dep_sync_outcome: sync.outcome,
    dep_sync_changed_count: sync.changes.length + sync.restored.length,
    dep_sync_migrated: sync.migratedFromCaret,
    dep_sync_opted_out: sync.optedOut,
    dep_sync_skew_warning: sync.skewWarning,
    dep_sync_reinstalled: sync.reinstalled,
  };
}

/**
 * Deploy-preflight entry point for managed dependency pinning: resolves the
 * CLI's vended CDK package.json (source of truth), the global opt-out, and the
 * distro-aware CLI install command, then runs the sync against the project's
 * agentcore/cdk directory. A future `agentcore build` command should call this same
 * function. Skipped entirely when AGENTCORE_SKIP_INSTALL is set (same escape hatch
 * as create --no-install and the language setup steps).
 *
 * Throws CliVersionTooOldError when the project was updated by a newer CLI (unless
 * `treatSkewAsWarning` or opted out), and DependencySyncError on rewrite/install failure.
 */
export async function ensureManagedDependencies(
  cdkProject: LocalCdkProject,
  options: EnsureManagedDependenciesOptions = {}
): Promise<DependencySyncResult> {
  if (process.env.AGENTCORE_SKIP_INSTALL) {
    return noOpSyncResult('skipped');
  }
  const disabled = readGlobalConfigSync().disableDependencyManagement === true;
  return syncManagedDependencies({
    vendedPackageJsonPath: getTemplatePath('cdk', 'package.json'),
    projectDir: cdkProject.projectDir,
    disabled,
    mode: options.checkOnly ? 'check' : 'apply',
    treatSkewAsWarning: options.treatSkewAsWarning,
    installCommand: getDistroConfig().installCommand,
  });
}
