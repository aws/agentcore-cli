import type { Command } from '../../../telemetry/schemas';
import type { ImportType } from './types';

export function toTelemetryCommand(importType: ImportType): Command {
  if (importType === 'starter-toolkit') return 'import';
  return `import.${importType}`;
}
