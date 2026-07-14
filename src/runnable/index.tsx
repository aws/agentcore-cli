import type { CommanderError } from "commander";

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
  const markUnavailable = () => {
    unavailable = true;
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
    return policy.commander.classify(error as CommanderError);
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

export async function runWithExitCode(
  fn: (argv: string[]) => Promise<void>,
  policy: InvocationExecutionPolicy,
  argv: string[] = process.argv,
): Promise<ExitCode> {
  let exitCode = ExitCode.SUCCESS;
  let diagnosticAttempted = false;
  try {
    await fn(argv);
  } catch (error: unknown) {
    const outcome = classify(policy, error);
    const message = guidance(outcome);
    if (message !== undefined) {
      exitCode = ExitCode.FAILURE;
      diagnosticAttempted = true;
      await policy.writeStderr(`${message}\n`);
    }
  }

  try {
    await policy.quiesce();
  } catch {
    exitCode = ExitCode.FAILURE;
  }

  if (policy.outputUnavailable() && !diagnosticAttempted) {
    exitCode = ExitCode.FAILURE;
    await policy.writeStderr(`${OUTPUT_UNAVAILABLE}\n`);
    try {
      await policy.quiesce();
    } catch {
      exitCode = ExitCode.FAILURE;
    }
  }

  try {
    policy.dispose();
  } catch {
    exitCode = ExitCode.FAILURE;
  }

  return policy.outputUnavailable() ? ExitCode.FAILURE : exitCode;
}
