import type { ImportType } from './types';
import type { Command } from '@/cli/telemetry/schemas';

export function toTelemetryCommand(importType: ImportType): Command {
  if (importType === 'starter-toolkit') return 'import';
  return `import.${importType}`;
}
