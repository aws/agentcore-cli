import { COMMAND_SCHEMAS, type Command, type CommandGroup } from './command-run.js';
import { ATTRIBUTES } from './common-shapes.js';
import { z } from 'zod';

/**
 * Metric registry — single source of truth for all metrics the CLI can emit.
 *
 * Per-command optional fields are derived from COMMAND_SCHEMAS automatically.
 * Adding a new command's attrs to COMMAND_SCHEMAS is sufficient — no manual
 * update here needed.
 */

// Merge all per-command schemas into a single partial type
type AllCommandSchemas = (typeof COMMAND_SCHEMAS)[keyof typeof COMMAND_SCHEMAS];
type MergedCommandAttrs = Partial<z.infer<AllCommandSchemas>>;

type CommandRunAttrs = {
  command: Command;
  command_group: CommandGroup;
  exit_reason: z.infer<typeof ATTRIBUTES.exit_reason>;
  error_name?: z.infer<typeof ATTRIBUTES.error_name>;
  error_source?: z.infer<typeof ATTRIBUTES.error_source>;
} & MergedCommandAttrs;

interface MetricRegistryItem {
  description?: string;
}
type MetricRegistry = Record<string, MetricRegistryItem>;

export const METRICS = {
  'cli.command_run': {
    description: 'CLI/TUI Command Execution',
  },
} as const satisfies MetricRegistry;

export type MetricName = keyof typeof METRICS;
export type MetricAttrs<M extends MetricName> = M extends 'cli.command_run' ? CommandRunAttrs : never;
