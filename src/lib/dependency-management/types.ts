export type DependencySection = 'dependencies' | 'devDependencies';

/** A package.json shape that preserves unknown fields verbatim. */
export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface DependencyChange {
  name: string;
  section: DependencySection;
  from: string;
  to: string;
}

export interface RestoredDependency {
  name: string;
  section: DependencySection;
  to: string;
}

export interface SkippedDependency {
  name: string;
  raw: string;
  reason: string;
}

/**
 * How the sync concluded:
 * - 'synced': the sync ran in apply mode (rewrites/installs happened as needed).
 * - 'check-only': `mode: 'check'` — plan computed, nothing written or installed.
 * - 'opted-out': dependency management disabled via global config — nothing written.
 * - 'skipped': the CLI layer skipped the sync entirely (AGENTCORE_SKIP_INSTALL).
 * - 'failure-suppressed': the sync threw on a teardown deploy and the failure was
 *   downgraded to a warning so the teardown could proceed.
 * - 'failed': the sync threw and the deploy failed with it (CliVersionTooOldError, or
 *   DependencySyncError on a non-teardown deploy). Attached by the CLI layer's failure
 *   path purely so dep_sync_* telemetry records that the sync itself was the failure.
 */
export type DependencySyncOutcome = 'synced' | 'check-only' | 'opted-out' | 'skipped' | 'failure-suppressed' | 'failed';

export interface DependencySyncResult {
  /**
   * Primary classification of the sync run. The booleans below preserve overlapping detail
   * (e.g. an opted-out run in check mode also has `checkOnly: true`).
   */
  outcome: DependencySyncOutcome;
  /** True when dependency management is disabled via global config — nothing was written. */
  optedOut: boolean;
  /** True when this was a check-only run (`mode: 'check'`) — plan computed, nothing written or installed. */
  checkOnly: boolean;
  /** True when the project predated pinning (caret ranges on managed deps were rewritten). */
  migratedFromCaret: boolean;
  /** True when `npm install` was run to reconcile the installed tree (manifest changed, or node_modules was missing). */
  reinstalled: boolean;
  /** True when a newer-than-CLI managed dep was found but downgraded to a warning (opted out or skew-as-warning). */
  skewWarning: boolean;
  changes: DependencyChange[];
  restored: RestoredDependency[];
  skipped: SkippedDependency[];
  /** Ready-to-print warning lines (downgraded skew, skipped specifiers). */
  warnings: string[];
  /** Ready-to-print user notice (migration message and/or change summary), null if nothing to say. */
  notice: string | null;
}

export interface SyncManagedDependenciesOptions {
  /** Path to the CLI's vended CDK package.json — source of truth for managed names + versions. */
  vendedPackageJsonPath: string;
  /** The user project's CDK directory (contains package.json, node_modules, lockfile). */
  projectDir: string;
  /** From global config `disableDependencyManagement`. When true: no writes, skew becomes a warning. */
  disabled?: boolean;
  /**
   * 'apply' (default) rewrites package.json and installs; 'check' only computes the plan and
   * user-facing wording — no writes, no install. Used by preview modes (--dry-run / --diff),
   * which must never mutate the working tree.
   */
  mode?: 'apply' | 'check';
  /**
   * Downgrade newer-than-CLI skew from CliVersionTooOldError to a warning even when managed.
   * Used by teardown deploys, where skew must not block destroying a cost-incurring stack.
   */
  treatSkewAsWarning?: boolean;
  /**
   * CLI upgrade command used in skew errors/warnings. The CLI layer passes the distro-aware
   * `getDistroConfig().installCommand`; defaults keep the lib module usable standalone.
   */
  installCommand?: string;
}
