/**
 * Semver parsing and comparison for managed-dependency syncing.
 *
 * Version parsing and comparison are delegated to node-semver (the `semver`
 * package), which implements full semver precedence including prerelease
 * ordering (0.1.0-alpha.19 < 0.1.0-alpha.20 < 0.1.0) — the dependency-check
 * parser in src/cli/external-requirements/versions.ts does not, as it drops
 * prerelease tags, which here would make an alpha downgrade look like a no-op.
 * The specifier classifier stays hand-rolled because the sync policy needs to
 * know whether a declared range was written as tilde, caret, or an exact pin,
 * and node-semver's Range API erases that distinction (it expands `~`/`^` into
 * plain comparators).
 */
import { parse } from 'semver';
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
