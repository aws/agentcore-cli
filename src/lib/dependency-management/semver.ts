/**
 * Semver parsing and comparison for managed-dependency syncing.
 *
 * Hybrid by design: version parsing and comparison are delegated to node-semver
 * (the `semver` package), which implements full semver precedence including
 * prerelease ordering (0.1.0-alpha.19 < 0.1.0-alpha.20 < 0.1.0) — the
 * dependency-check parser in src/cli/external-requirements/versions.ts does not,
 * as it drops prerelease tags, which here would make an alpha downgrade look
 * like a no-op. The specifier classifier stays hand-rolled because the sync
 * policy needs to know whether a declared range was written as tilde, caret, or
 * an exact pin, and node-semver's Range API erases that distinction (it expands
 * `~`/`^` into plain comparators). So: node-semver for parse/compare, plus our
 * own thin prefix classifier.
 */
import { compare, parse } from 'semver';
import type { SemVer } from 'semver';

/** A parsed version: node-semver's SemVer (major / minor / patch / prerelease). */
export type ParsedVersion = SemVer;

export type SpecifierKind = 'exact' | 'tilde' | 'caret';

export type ParsedSpecifier =
  | { kind: SpecifierKind; version: ParsedVersion; raw: string }
  | { kind: 'unsupported'; raw: string };

export function parseVersion(version: string): ParsedVersion | null {
  // npm accepts a single leading 'v' or 'V' on version strings (v1.2.3, ~v1.2.3);
  // node-semver only recognizes the lowercase form, so normalize before parsing.
  const normalized = version.trim().replace(/^V/, 'v');
  return parse(normalized, { loose: false });
}

/**
 * Compare two versions per the semver spec, including prerelease precedence:
 * numeric identifiers compare numerically and rank below alphanumeric ones,
 * and a prerelease version ranks below its release (1.0.0-alpha < 1.0.0).
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return compare(a, b);
}

/**
 * Parse an npm dependency specifier into exact / tilde / caret + base version.
 * Anything else (file:, git:, workspace:, URLs, wildcards, compound ranges, tags)
 * is 'unsupported' — the sync skips those rather than guessing. Strict parsing
 * (no loose/coerce) keeps `1.x`, `*`, `latest`, and `>=1.2.3` unsupported.
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
