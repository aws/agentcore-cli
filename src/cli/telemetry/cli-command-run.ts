import { getErrorMessage } from '../errors';
import type { AddResult } from '../primitives/types.js';
import { TelemetryClientAccessor } from './client-accessor.js';
import type { Command, CommandAttrs } from './schemas/command-run.js';

/**
 * Run a CLI command with telemetry, standardized error output, and process.exit.
 * The callback should throw on failure and return telemetry attrs on success.
 *
 * If telemetry initialization fails, the command still runs without telemetry —
 * telemetry must never block CLI behavior.
 */
export async function cliCommandRun<C extends Command>(
  command: C,
  json: boolean,
  fn: () => Promise<CommandAttrs<C>>
): Promise<never> {
  try {
    let client;
    try {
      client = await TelemetryClientAccessor.get();
    } catch {
      // Telemetry init failed — run without it
      await fn();
      process.exit(0);
    }
    // withCommandRun records success/failure telemetry, then re-throws on failure
    await client.withCommandRun(command, fn);
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

/**
 * Wrap a primitive .add() call with telemetry — used by TUI paths.
 * CLI paths use {@link cliCommandRun} instead.
 */
export async function withAddTelemetry<C extends Command, T extends Record<string, unknown>>(
  command: C,
  attrs: CommandAttrs<C>,
  fn: () => Promise<AddResult<T>>
): Promise<AddResult<T>> {
  let client;
  try {
    client = await TelemetryClientAccessor.get();
  } catch {
    return fn();
  }

  let result: AddResult<T> | undefined;
  try {
    await client.withCommandRun(command, async () => {
      result = await fn();
      if (!result.success) throw new Error(result.error);
      return attrs;
    });
  } catch (err) {
    // withCommandRun re-throws after recording failure telemetry.
    // result is set if fn() ran; if not, fn() itself threw.
    if (!result) {
      return { success: false, error: getErrorMessage(err) };
    }
  }
  return result!;
}
