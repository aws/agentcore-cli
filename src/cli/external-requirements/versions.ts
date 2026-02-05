/**
 * Semantic version parsing and comparison utilities.
 */

/**
 * Parsed semantic version with major.minor.patch components.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a semver string into components.
 * Handles formats like "v18.0.0", "18.0.0", "0.9.2", etc.
 */
export function parseSemVer(version: string): SemVer | null {
  // Strip leading 'v' if present
  const normalized = version.replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(normalized);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
  };
}

/**
 * Compare two semver versions.
 * Returns: negative if a < b, 0 if a == b, positive if a > b
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Check if version a is >= version b.
 */
export function semVerGte(a: SemVer, b: SemVer): boolean {
  return compareSemVer(a, b) >= 0;
}

/**
 * Format a SemVer back to string.
 */
export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// =============================================================================
// Minimum version requirements
// =============================================================================

/** Minimum Node.js version required for CDK synth (ES2022 target) */
export const NODE_MIN_VERSION: SemVer = { major: 18, minor: 0, patch: 0 };
