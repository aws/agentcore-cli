import { CommanderError } from "commander";
import { AgentCoreCLIError } from "../errors";

// ExitCode provides names for default Unix exit codes.
export enum ExitCode {
  SUCCESS = 0,
  FAILURE = 1,
  USAGE = 2,
  INTERRUPTED = 130,
}

function externallyHandledError(error: unknown): unknown {
  if ((error as { reported?: boolean } | null)?.reported === true) return error;
  if (!(error instanceof AgentCoreCLIError)) return error;

  const cause = error.cause;
  if (
    cause instanceof CommanderError ||
    (cause as { reported?: boolean } | null)?.reported === true ||
    (cause as Error)?.name === "AbortError"
  ) {
    return cause;
  }
  return error;
}

// Runnable can be implemented by any application's main entrypoint.
export interface Runnable {
  run(argv: string[]): Promise<void>;
}

// runRunnable creates and runs any instance of Runnable with proper exit code handling.
export function runRunnable(
  createRunnable: () => Runnable,
  argv: string[] = process.argv,
): Promise<number> {
  return runWithExitCode(async () => {
    await createRunnable().run(argv);
  });
}

// runWithExitCode safely runs the given function with exit code handling.
export async function runWithExitCode(
  fn: (argv: string[]) => Promise<void>,
  argv: string[] = process.argv,
): Promise<number> {
  try {
    await fn(argv);
    return ExitCode.SUCCESS;
  } catch (caught) {
    const error = externallyHandledError(caught);
    if (
      !(error instanceof CommanderError) &&
      (error as { reported?: boolean } | null)?.reported !== true
    ) {
      const reported = error instanceof Error ? error : new Error(String(error));
      const name = reported instanceof AgentCoreCLIError ? "Error" : reported.name;
      console.error(`${name}: ${reported.message}`);
    }
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.SUCCESS : ExitCode.USAGE;
    }
    if ((error as Error)?.name === "AbortError") return ExitCode.INTERRUPTED;
    if (caught instanceof AgentCoreCLIError) return caught.exitCode;
    return ExitCode.FAILURE;
  }
}
