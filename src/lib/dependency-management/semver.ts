/**
 * Minimal semver parsing and comparison for managed-dependency syncing.
 *
 * Deliberately self-contained (no imports): this module must compare prerelease
 * versions correctly (0.1.0-alpha.19 < 0.1.0-alpha.20 < 0.1.0), which the
 * dependency-check parser in src/cli/external-requirements/versions.ts does not —
 * it drops prerelease tags, which here would make an alpha downgrade look like a no-op.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, e.g. ['alpha', 19]. Empty for release versions. */
  prerelease: (string | number)[];
}

export type SpecifierKind = 'exact' | 'tilde' | 'caret';

export type ParsedSpecifier =
  | { kind: SpecifierKind; version: ParsedVersion; raw: string }
  | { kind: 'unsupported'; raw: string };

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/**
 * Compare two versions per the semver spec, including prerelease precedence:
 * numeric identifiers compare numerically and rank below alphanumeric ones,
 * and a prerelease version ranks below its release (1.0.0-alpha < 1.0.0).
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const idA = a.prerelease[i];
    const idB = b.prerelease[i];
    // A larger identifier set has higher precedence (1.0.0-alpha < 1.0.0-alpha.1)
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;
    if (typeof idA === 'number' && typeof idB === 'number') return idA - idB;
    if (typeof idA === 'number') return -1; // numeric identifiers rank below alphanumeric
    if (typeof idB === 'number') return 1;
    return idA < idB ? -1 : 1;
  }
  return 0;
}

/**
 * Parse an npm dependency specifier into exact / tilde / caret + base version.
 * Anything else (file:, git:, workspace:, URLs, wildcards, compound ranges, tags)
 * is 'unsupported' — the sync skips those rather than guessing.
 */
export function parseSpecifier(raw: string): ParsedSpecifier {
  const trimmed = raw.trim();
  let kind: SpecifierKind = 'exact';
  let versionPart = trimmed;

  if (trimmed.startsWith('~')) {
    kind = 'tilde';
    versionPart = trimmed.slice(1);
  } else if (trimmed.startsWith('^')) {
    kind = 'caret';
    versionPart = trimmed.slice(1);
  } else if (trimmed.startsWith('=')) {
    versionPart = trimmed.slice(1);
  }

  const version = parseVersion(versionPart);
  if (!version) return { kind: 'unsupported', raw };
  return { kind, version, raw };
}

export function formatVersion(v: ParsedVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base;
}
