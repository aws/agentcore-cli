import type { SkewFinding } from './plan';
import type { DependencyChange, RestoredDependency, SkippedDependency } from './types';

/**
 * Single source of user-facing wording for dependency management, so the
 * headless and TUI deploy paths (and any future CLI) can't drift apart.
 */

/**
 * Fallback CLI install command when the caller doesn't thread one in. The CLI layer
 * passes `getDistroConfig().installCommand` (dist-tag/registry aware); this default
 * keeps the lib module usable standalone.
 */
export const DEFAULT_CLI_INSTALL_COMMAND = 'npm install -g @aws/agentcore@latest';

export const OPT_OUT_HINT = 'To manage these versions yourself: agentcore config disableDependencyManagement true';

const MIGRATION_PREAMBLE =
  'Your project was created before the AgentCore CLI managed dependency versions.\n' +
  "We've updated agentcore/cdk/package.json so the CLI keeps these dependencies\n" +
  'on versions it has been tested with (patch updates still apply automatically):';

// Check-mode variant: nothing was written, so the wording must promise rather than claim.
const MIGRATION_PREAMBLE_PENDING =
  'Your project was created before the AgentCore CLI managed dependency versions.\n' +
  'agentcore/cdk/package.json will be updated on the next deploy so the CLI keeps these\n' +
  'dependencies on versions it has been tested with (patch updates still apply automatically):';

function formatSkewList(skew: SkewFinding[]): string {
  return skew.map(s => `${s.name} (${s.declared}, CLI expects ${s.expected})`).join(', ');
}

/**
 * Error text for newer-than-CLI skew. Names the skewed dependencies, gives the
 * distro-correct upgrade command, and — because the skew may be a deliberate manual
 * bump rather than a newer CLI — points at the opt-out as the alternative.
 */
export function formatCliUpgradeError(skew: SkewFinding[], installCommand: string): string {
  const plural = skew.length > 1;
  return (
    `This project requires a newer version of the AgentCore CLI: ${formatSkewList(skew)} ` +
    `${plural ? 'are' : 'is'} newer than this CLI was tested with. ` +
    `Run \`${installCommand}\` and retry.\n` +
    `If you intentionally updated ${plural ? 'these dependencies' : 'this dependency'} yourself, ` +
    'you can disable managed dependency versions instead:\n' +
    OPT_OUT_HINT
  );
}

function formatChangeTable(changes: DependencyChange[], restored: RestoredDependency[]): string {
  const rows: { name: string; from: string; to: string }[] = [
    ...changes.map(c => ({ name: c.name, from: c.from, to: c.to })),
    ...restored.map(r => ({ name: r.name, from: '(removed)', to: r.to })),
  ];
  const nameWidth = Math.max(...rows.map(r => r.name.length));
  const fromWidth = Math.max(...rows.map(r => r.from.length));
  return rows.map(r => `  ${r.name.padEnd(nameWidth)}  ${r.from.padEnd(fromWidth)} → ${r.to}`).join('\n');
}

export function formatSyncNotice(options: {
  migratedFromCaret: boolean;
  changes: DependencyChange[];
  restored: RestoredDependency[];
  reinstalled: boolean;
  /** False in check mode — nothing was written, so speak in the future tense. */
  applied: boolean;
}): string | null {
  const { migratedFromCaret, changes, restored, reinstalled, applied } = options;
  if (changes.length === 0 && restored.length === 0) return null;

  const lines: string[] = [];
  if (migratedFromCaret) {
    lines.push(applied ? MIGRATION_PREAMBLE : MIGRATION_PREAMBLE_PENDING);
  } else {
    lines.push(
      applied
        ? 'Updated managed dependencies in agentcore/cdk/package.json:'
        : 'Managed dependencies in agentcore/cdk/package.json will be updated on the next deploy:'
    );
  }
  lines.push('');
  lines.push(formatChangeTable(changes, restored));
  lines.push('');
  if (reinstalled) {
    lines.push('Ran npm install in agentcore/cdk to apply the updates.');
  }
  lines.push(
    applied
      ? 'Dependencies you added yourself were not changed.'
      : 'Dependencies you added yourself will not be changed.'
  );
  if (migratedFromCaret) {
    lines.push(OPT_OUT_HINT);
  }
  return lines.join('\n');
}

export function formatSkewWarning(skew: SkewFinding[], installCommand: string): string {
  return (
    `${formatSkewList(skew)} ${skew.length === 1 ? 'is' : 'are'} newer than this CLI was tested with; ` +
    `deploy may fail — upgrade the CLI with \`${installCommand}\`. ${OPT_OUT_HINT}`
  );
}

export function formatSkippedWarning(skipped: SkippedDependency): string {
  return `${skipped.name} (${skipped.raw}) ${skipped.reason}.`;
}
