import { parseSpecifier } from './semver';
import type { ParsedSpecifier } from './semver';
import type {
  DependencyChange,
  DependencySection,
  PackageManifest,
  RestoredDependency,
  SkippedDependency,
} from './types';
import { compare } from 'semver';

/**
 * Pure policy computation for managed-dependency syncing. No I/O.
 *
 * A dependency is "managed" iff its name appears in the vended manifest
 * (dependencies or devDependencies). The vended specifier is authoritative:
 * the sync copies it verbatim, so the pinning policy (tilde for stable deps,
 * exact for L3 constructs) lives entirely in the vended asset.
 */

export interface SkewFinding {
  name: string;
  declared: string;
  expected: string;
}

export interface SyncPlan {
  /** Managed deps where the project declares a newer minor/major than the CLI expects. */
  skew: SkewFinding[];
  changes: DependencyChange[];
  restored: RestoredDependency[];
  skipped: SkippedDependency[];
  /** True when any managed dep had a caret range — the project predates pinning. */
  migratedFromCaret: boolean;
}

const SECTIONS: DependencySection[] = ['dependencies', 'devDependencies'];

function findDeclared(manifest: PackageManifest, name: string): { section: DependencySection; raw: string } | null {
  for (const section of SECTIONS) {
    const raw = manifest[section]?.[name];
    if (raw !== undefined) return { section, raw };
  }
  return null;
}

/**
 * Skew exists when the project's declared base version is ahead of the CLI's
 * expectation in a way patch-floating can't explain: a higher major.minor for
 * ranged deps, or any prerelease-aware greater-than for exact pins (so an
 * alpha.20 project is never silently downgraded to an alpha.19 CLI's pin).
 */
function isSkewed(declared: ParsedSpecifier, expected: ParsedSpecifier): boolean {
  if (declared.kind === 'unsupported' || expected.kind === 'unsupported') return false;
  const d = declared.version;
  const e = expected.version;
  if (expected.kind === 'exact') return compare(d, e) > 0;
  if (d.major !== e.major) return d.major > e.major;
  return d.minor > e.minor;
}

export function computeSyncPlan(vended: PackageManifest, project: PackageManifest): SyncPlan {
  const plan: SyncPlan = { skew: [], changes: [], restored: [], skipped: [], migratedFromCaret: false };

  for (const section of SECTIONS) {
    for (const [name, expectedRaw] of Object.entries(vended[section] ?? {})) {
      const expected = parseSpecifier(expectedRaw);
      const declared = findDeclared(project, name);

      if (!declared) {
        // Managed dep deleted by the user — the vended CDK app can't build without it.
        plan.restored.push({ name, section, to: expectedRaw });
        continue;
      }

      if (declared.raw === expectedRaw) continue;

      const declaredSpec = parseSpecifier(declared.raw);
      if (declaredSpec.kind === 'unsupported') {
        // file:/git:/tag/range specifiers (incl. the bundled-tarball override) are
        // deliberate local overrides — never rewrite, never skew-check.
        plan.skipped.push({
          name,
          raw: declared.raw,
          reason: 'uses a non-semver specifier and was left unmanaged',
        });
        continue;
      }

      if (isSkewed(declaredSpec, expected)) {
        plan.skew.push({ name, declared: declared.raw, expected: expectedRaw });
        continue;
      }

      if (declaredSpec.kind === 'caret') plan.migratedFromCaret = true;
      plan.changes.push({ name, section: declared.section, from: declared.raw, to: expectedRaw });
    }
  }

  return plan;
}
