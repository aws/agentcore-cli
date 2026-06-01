import type { Result } from '../../lib/result';
import { resilientParse } from '../../lib/utils/zod.js';
import { getErrorMessage } from '../errors';
import { type AttributeRecorder, createAttributeRecorder } from './attribute-recorder.js';
import { TelemetryClientAccessor } from './client-accessor.js';
import { TelemetryClient } from './client.js';
import { classifyError } from './error.js';
import { COMMAND_SCHEMAS, type Command, type CommandAttrs, deriveCommandGroup } from './schemas/command-run.js';
import { type CommandResult, CommandResultSchema } from './schemas/common-shapes.js';
import { performance } from 'perf_hooks';

export type { AttributeRecorder } from './attribute-recorder.js';

async function getTelemetryClient() {
  try {
    return await TelemetryClientAccessor.get();
  } catch {
    return undefined;
  }
}

function recordCommandRun<C extends Command>(
  client: TelemetryClient,
  command: C,
  result: CommandResult,
  attrs: CommandAttrs<C> | Partial<CommandAttrs<C>>,
  durationMs: number
): void {
  try {
    CommandResultSchema.parse(result);

    const validatedAttrs =
      Object.keys(attrs as Record<string, unknown>).length > 0
        ? resilientParse(COMMAND_SCHEMAS[command], attrs as Record<string, unknown>, {
            fallback: 'unknown',
            fillMissing: true,
            keepUnknown: false,
          })
        : attrs;

    client.emit('cli.command_run', durationMs, {
      command_group: deriveCommandGroup(command),
      command,
      ...result,
      ...validatedAttrs,
    });
  } catch {
    // Telemetry must never affect CLI behavior
  }
}

/**
 * Return attrs on success
 * Unhandled throws are classified as failures and re-thrown.
 */
async function trackCommandRun<C extends Command>(
  client: TelemetryClient,
  command: C,
  fn: () => CommandAttrs<C> | Promise<CommandAttrs<C>>,
  fallbackAttrs?: Partial<CommandAttrs<C>>
): Promise<void> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    recordCommandRun(client, command, { exit_reason: 'success' }, result, durationMs);
  } catch (err) {
    const { category, source } = classifyError(err);
    const failureResult: CommandResult & { exit_reason: 'failure' } = {
      exit_reason: 'failure',
      error_name: category,
      error_source: source,
    };
    recordCommandRun(client, command, failureResult, fallbackAttrs ?? {}, Math.round(performance.now() - start));
    throw err;
  } finally {
    await client.flush();
  }
}

/**
 * Record telemetry for an operation and return its result.
 * Use in TUI hooks and CLI paths where the caller handles output and control flow.
 *
 * If the callback returns a failure result, telemetry is recorded and the result
 * is returned to the caller. If the callback throws, telemetry is recorded before
 * rethrowing the exception.
 * If telemetry is unavailable, the callback runs untracked.
 *
 * The callback receives an AttributeRecorder to dynamically set or override attributes.
 * Initial attributes are seeded into the recorder; the callback may call recorder.set()
 * to override or supplement them at any point during execution.
 */
export async function withCommandRunTelemetry<C extends Command, R extends Result>(
  command: C,
  attributes: CommandAttrs<C>,
  fn: (recorder: AttributeRecorder<CommandAttrs<C>>) => R | Promise<R>
): Promise<R> {
  const client = await getTelemetryClient();
  const recorder = createAttributeRecorder<CommandAttrs<C>>();
  recorder.set(attributes);
  const start = performance.now();
  try {
    const result = await fn(recorder);
    if (client) {
      const durationMs = Math.round(performance.now() - start);
      if (!result.success) {
        const { category, source } = classifyError(result.error);
        recordCommandRun(
          client,
          command,
          { exit_reason: 'failure', error_name: category, error_source: source },
          recorder.get(),
          durationMs
        );
      } else {
        recordCommandRun(client, command, { exit_reason: 'success' }, recorder.get(), durationMs);
      }
    }
    return result;
  } catch (e) {
    if (client) {
      const { category, source } = classifyError(e);
      recordCommandRun(
        client,
        command,
        { exit_reason: 'failure', error_name: category, error_source: source },
        recorder.get(),
        Math.round(performance.now() - start)
      );
    }
    throw e;
  } finally {
    await client?.flush();
  }
}

/**
 * Record telemetry, print errors, and exit the process.
 * Use in CLI command handlers where the command is the final action.
 * The callback returns attrs on success and throws on failure.
 * Pass knownAttrs to record command-specific attributes even on failure.
 */
export async function runCliCommand<C extends Command>(
  command: C,
  json: boolean,
  fn: () => Promise<CommandAttrs<C>>,
  knownAttrs?: Partial<CommandAttrs<C>>
): Promise<never> {
  try {
    const client = await getTelemetryClient();
    if (!client) {
      await fn();
      process.exit(0);
    }
    await trackCommandRun(client, command, fn, knownAttrs);
    process.exit(0);
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
    } else {
      console.error(getErrorMessage(error));
    }
    process.exit(1);
  }
}
