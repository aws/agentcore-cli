import { classifyError, isUserError } from './error-classification.js';
import { COMMAND_SCHEMAS, type Command, type CommandAttrs, deriveCommandGroup } from './schemas/command-run.js';
import { type CommandResult, CommandResultSchema, resilientParse } from './schemas/common-shapes.js';
import type { MetricSink } from './sinks/metric-sink.js';
import { performance } from 'perf_hooks';

/** Return this from the withCommandRun callback to record a cancellation. */
export const CANCELLED = Symbol('cancelled');

export class TelemetryClient {
  constructor(private readonly sink: MetricSink) {}

  /**
   * Wrap a command action with telemetry recording.
   *
   * Return attrs on success, or CANCELLED on user cancellation.
   * Unhandled throws are classified as failures and re-thrown.
   *
   * ```ts
   * await client.withCommandRun('deploy', async () => {
   *   if (userCancelled) return CANCELLED;
   *   const result = await runDeploy(options);
   *   return { runtime_count: result.runtimes.length, ... };
   * });
   * ```
   */
  async withCommandRun<C extends Command>(
    command: C,
    fn: () => CommandAttrs<C> | typeof CANCELLED | Promise<CommandAttrs<C> | typeof CANCELLED>
  ): Promise<void> {
    const start = performance.now();
    try {
      const result = await fn();
      const durationMs = Math.round(performance.now() - start);
      if (result === CANCELLED) {
        this.recordCommandRun(command, { exit_reason: 'cancel' }, {}, durationMs);
      } else {
        this.recordCommandRun(command, { exit_reason: 'success' }, result, durationMs);
      }
    } catch (err) {
      const failureResult: CommandResult & { exit_reason: 'failure' } = {
        exit_reason: 'failure',
        error_name: classifyError(err),
        is_user_error: isUserError(err),
      };
      this.recordCommandRun(command, failureResult, {}, Math.round(performance.now() - start));
      throw err;
    } finally {
      try {
        await this.sink.flush();
      } catch {
        /* telemetry must not mask command errors */
      }
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.sink.shutdown();
    } catch {
      /* telemetry must not affect CLI behavior */
    }
  }

  private recordCommandRun<C extends Command>(
    command: C,
    result: CommandResult,
    attrs: CommandAttrs<C> | Partial<CommandAttrs<C>>,
    durationMs: number
  ): void {
    try {
      // CommandResult is built internally — hard parse is intentional since
      // a metric without a valid exit_reason is meaningless.
      CommandResultSchema.parse(result);

      // Validate command attrs resiliently: invalid fields default to 'unknown'
      // instead of dropping the entire metric.
      // On failure/cancel the callback attrs are empty so validation is skipped.
      const validatedAttrs =
        result.exit_reason !== 'failure' && result.exit_reason !== 'cancel'
          ? resilientParse(COMMAND_SCHEMAS[command], attrs as Record<string, unknown>)
          : attrs;

      const otelAttrs: Record<string, string | number> = {
        command_group: deriveCommandGroup(command),
        command,
      };

      for (const obj of [result, validatedAttrs]) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'boolean') {
            otelAttrs[k] = String(v);
          } else if (typeof v === 'string' || typeof v === 'number') {
            otelAttrs[k] = v;
          }
        }
      }

      this.sink.record(durationMs, otelAttrs);
    } catch {
      // Telemetry must never affect CLI behavior
    }
  }
}
