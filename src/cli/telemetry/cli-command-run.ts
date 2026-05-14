import type { Result } from '../../lib/result';
import { getErrorMessage } from '../errors';
import { TelemetryClientAccessor } from './client-accessor.js';
import { TelemetryClient } from './client.js';
import { classifyError, isUserError } from './error-classification.js';
import { COMMAND_SCHEMAS, type Command, type CommandAttrs, deriveCommandGroup } from './schemas/command-run.js';
import { type CommandResult, CommandResultSchema, resilientParse } from './schemas/common-shapes.js';
import { performance } from 'perf_hooks';

/** Return this from the trackCommandRun callback to record a cancellation. */
const CANCELLED = Symbol('cancelled');

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
        ? resilientParse(COMMAND_SCHEMAS[command], attrs as Record<string, unknown>)
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
 * Return attrs on success, or CANCELLED on user cancellation.
 * Unhandled throws are classified as failures and re-thrown.
 */
async function trackCommandRun<C extends Command>(
  client: TelemetryClient,
  command: C,
  fn: () => CommandAttrs<C> | typeof CANCELLED | Promise<CommandAttrs<C> | typeof CANCELLED>,
  fallbackAttrs?: Partial<CommandAttrs<C>>
): Promise<void> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    if (result === CANCELLED) {
      recordCommandRun(client, command, { exit_reason: 'cancel' }, {}, durationMs);
    } else {
      recordCommandRun(client, command, { exit_reason: 'success' }, result, durationMs);
    }
  } catch (err) {
    const failureResult: CommandResult & { exit_reason: 'failure' } = {
      exit_reason: 'failure',
      error_name: classifyError(err),
      is_user_error: isUserError(err),
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
 * is returned to the caller. If the callback throws, telemetry is recorded and
 * the exception propagates. If telemetry is unavailable, the callback runs untracked.
 */
export async function withCommandRunTelemetry<C extends Command, R extends Result>(
  command: C,
  attrs: CommandAttrs<C>,
  fn: () => R | Promise<R>
): Promise<R> {
  const client = await getTelemetryClient();
  if (!client) return fn();

  let result: R | undefined;
  try {
    await trackCommandRun(
      client,
      command,
      async () => {
        result = await fn();
        if (!result.success) throw result.error;
        return attrs;
      },
      attrs
    );
  } catch (e) {
    // trackCommandRun re-throws after recording failure telemetry.
    // If result was set, fn() returned a failure result — return it directly.
    // If not, fn() itself threw — convert to a failure result so callers
    // that don't wrap in try/catch (e.g. TUI hooks) don't leak unhandled rejections.
    if (!result) {
      return { success: false, error: e instanceof Error ? e : new Error(getErrorMessage(e)) } as R;
    }
  }
  return result!;
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
