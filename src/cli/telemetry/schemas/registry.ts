import { ATTRIBUTES, safeSchema } from './common-shapes.js';
import { z } from 'zod';

/**
 * Metric registry — single source of truth for all metrics the CLI can emit.
 * Adding a new metric = adding one entry here.
 *
 * The schema defines the base attributes for compile-time type safety on emit().
 * For cli.command_run, per-command attributes are validated separately via COMMAND_SCHEMAS.
 */
export const METRICS = {
  'cli.command_run': {
    instrument: 'histogram',
    schema: safeSchema({
      command: ATTRIBUTES.Command,
      command_group: ATTRIBUTES.CommandGroup,
      exit_reason: ATTRIBUTES.ExitReason,
    }),
  },
} as const;

export type MetricName = keyof typeof METRICS;
export type Instrument = (typeof METRICS)[MetricName]['instrument'];
export type MetricAttrs<M extends MetricName> = z.infer<(typeof METRICS)[M]['schema']>;
