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

export interface DependencySyncResult {
  /** True when dependency management is disabled via global config — nothing was written. */
  optedOut: boolean;
  /** True when the project predated pinning (caret ranges on managed deps were rewritten). */
  migrated: boolean;
  /** True when node_modules + lockfile were deleted and reinstalled. */
  reinstalled: boolean;
  /** True when a newer-than-CLI managed dep was found while opted out (warned instead of thrown). */
  skewWarning: boolean;
  changes: DependencyChange[];
  restored: RestoredDependency[];
  skipped: SkippedDependency[];
  /** Ready-to-print warning lines (opted-out skew, skipped specifiers). */
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
}
