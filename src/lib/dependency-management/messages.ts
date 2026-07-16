import type { SkewFinding } from './policy';
import type { DependencyChange, RestoredDependency, SkippedDependency } from './types';

/**
 * Single source of user-facing wording for dependency management, so the
 * headless and TUI deploy paths (and any future CLI) can't drift apart.
 */

export const CLI_UPGRADE_ERROR_MESSAGE =
  'This project requires a newer version of the AgentCore CLI. ' +
  'Run `npm install -g @aws/agentcore-cli@latest` and retry.';

export const OPT_OUT_HINT = 'To manage these versions yourself: agentcore config disableDependencyManagement true';

const MIGRATION_PREAMBLE =
  'Your project was created before the AgentCore CLI managed dependency versions.\n' +
  "We've updated agentcore/cdk/package.json so the CLI keeps these dependencies\n" +
  'on versions it has been tested with (patch updates still apply automatically):';

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
  migrated: boolean;
  changes: DependencyChange[];
  restored: RestoredDependency[];
  reinstalled: boolean;
}): string | null {
  const { migrated, changes, restored, reinstalled } = options;
  if (changes.length === 0 && restored.length === 0) return null;

  const lines: string[] = [];
  if (migrated) {
    lines.push(MIGRATION_PREAMBLE);
  } else {
    lines.push('Updated managed dependencies in agentcore/cdk/package.json:');
  }
  lines.push('');
  lines.push(formatChangeTable(changes, restored));
  lines.push('');
  if (reinstalled) {
    lines.push('Reinstalled agentcore/cdk dependencies.');
  }
  lines.push('Dependencies you added yourself were not changed.');
  if (migrated) {
    lines.push(OPT_OUT_HINT);
  }
  return lines.join('\n');
}

export function formatSkewWarning(skew: SkewFinding[]): string {
  const deps = skew.map(s => `${s.name} (${s.declared}, CLI expects ${s.expected})`).join(', ');
  return (
    `${deps} ${skew.length === 1 ? 'is' : 'are'} newer than this CLI was tested with; ` +
    'deploy may fail — upgrade the CLI with `npm install -g @aws/agentcore-cli@latest`.'
  );
}

export function formatSkippedWarning(skipped: SkippedDependency): string {
  return `${skipped.name} (${skipped.raw}) ${skipped.reason}.`;
}
