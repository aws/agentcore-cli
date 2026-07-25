import { AgentCoreCLIError } from "../errors";

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
    return 0;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(`${error.name}: ${error.message}`);

    return error instanceof AgentCoreCLIError ? error.exitCode : 1;
  }
}
