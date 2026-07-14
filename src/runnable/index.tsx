import {
  createCommanderExecutionPolicy,
  type CommanderExecutionPolicy,
  type CommanderExitOutcome,
} from "../router/executionPolicy";
import type { OutputWriteOutcome, StreamSupervisor } from "../runtime/output/types";

export enum ExitCode {
  SUCCESS = 0,
  FAILURE = 1,
}

export interface Runnable {
  run(argv: string[]): Promise<void>;
}

export interface InvocationExecutionPolicy {
  readonly commander: CommanderExecutionPolicy;
  writeStderr(text: string): Promise<OutputWriteOutcome>;
  outputUnavailable(): boolean;
  quiesce(): Promise<void>;
  dispose(): void;
}

const INTERNAL_ERROR = "An internal error occurred.";
const OUTPUT_UNAVAILABLE = "Command output could not be written.";

const USAGE_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  "commander.missingArgument": "A required argument is missing. Run with --help for usage.",
  "commander.optionMissingArgument": "An option value is missing. Run with --help for usage.",
  "commander.missingMandatoryOptionValue":
    "A required option is missing. Run with --help for usage.",
  "commander.conflictingOption": "Conflicting options were provided. Run with --help for usage.",
  "commander.unknownOption": "An unknown option was provided. Run with --help for usage.",
  "commander.excessArguments": "Too many arguments were provided. Run with --help for usage.",
  "commander.unknownCommand": "An unknown command was provided. Run with --help for usage.",
  "commander.invalidArgument": "An option or argument is invalid. Run with --help for usage.",
  "commander.error": "An option or argument is invalid. Run with --help for usage.",
});

export function createInvocationExecutionPolicy(
  supervisor: StreamSupervisor,
): InvocationExecutionPolicy {
  let unavailable = false;
  const markUnavailable = (): undefined => {
    unavailable = true;
    return undefined;
  };
  const writeStderr = async (text: string): Promise<OutputWriteOutcome> => {
    try {
      const outcome = await supervisor.stderr.writeUtf8(text);
      if (outcome.kind === "outputUnavailable") {
        markUnavailable();
      }
      return outcome;
    } catch {
      markUnavailable();
      return { kind: "outputUnavailable" };
    }
  };

  return {
    commander: createCommanderExecutionPolicy(supervisor, markUnavailable),
    writeStderr,
    outputUnavailable: () => unavailable,
    quiesce: () => supervisor.quiesce(),
    dispose: () => supervisor.dispose(),
  };
}

export function runRunnable(
  createRunnable: () => Runnable,
  policy: InvocationExecutionPolicy,
  argv: string[] = process.argv,
): Promise<ExitCode> {
  return runWithExitCode(
    async () => {
      await createRunnable().run(argv);
    },
    policy,
    argv,
  );
}

function classify(policy: InvocationExecutionPolicy, error: unknown): CommanderExitOutcome {
  try {
    return policy.commander.classify(error);
  } catch {
    return { kind: "internal" };
  }
}

function guidance(outcome: CommanderExitOutcome): string | undefined {
  if (outcome.kind === "success") {
    return undefined;
  }
  if (outcome.kind === "usage") {
    return USAGE_GUIDANCE[outcome.code] ?? INTERNAL_ERROR;
  }
  return INTERNAL_ERROR;
}

async function writeStderr(policy: InvocationExecutionPolicy, text: string): Promise<boolean> {
  try {
    const outcome = await policy.writeStderr(text);
    return outcome.kind === "outputUnavailable";
  } catch {
    return true;
  }
}

async function quiesce(policy: InvocationExecutionPolicy): Promise<boolean> {
  try {
    await policy.quiesce();
    return true;
  } catch {
    return false;
  }
}

function outputUnavailable(policy: InvocationExecutionPolicy): boolean {
  try {
    return policy.outputUnavailable();
  } catch {
    return true;
  }
}

export async function runWithExitCode(
  fn: (argv: string[]) => Promise<void>,
  policy: InvocationExecutionPolicy,
  argv: string[] = process.argv,
): Promise<ExitCode> {
  let exitCode = ExitCode.SUCCESS;
  let diagnosticAttempted = false;
  try {
    try {
      await fn(argv);
    } catch (error: unknown) {
      const outcome = classify(policy, error);
      const message = guidance(outcome);
      if (message !== undefined) {
        exitCode = ExitCode.FAILURE;
        diagnosticAttempted = true;
        if (await writeStderr(policy, `${message}\n`)) {
          exitCode = ExitCode.FAILURE;
        }
      }
    }

    if (!(await quiesce(policy))) {
      exitCode = ExitCode.FAILURE;
    }

    if (outputUnavailable(policy)) {
      exitCode = ExitCode.FAILURE;
      if (!diagnosticAttempted) {
        diagnosticAttempted = true;
        await writeStderr(policy, `${OUTPUT_UNAVAILABLE}\n`);
        if (!(await quiesce(policy))) {
          exitCode = ExitCode.FAILURE;
        }
      }
    }
  } catch {
    exitCode = ExitCode.FAILURE;
  } finally {
    try {
      policy.dispose();
    } catch {
      exitCode = ExitCode.FAILURE;
    }
  }

  return exitCode;
}
