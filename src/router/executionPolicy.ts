import { CommanderError, type Command } from "commander";

import type {
  AwaitedOutputSink,
  OutputWriteOutcome,
  StreamSupervisor,
} from "../runtime/output/types";

export type CommanderExitOutcome =
  | Readonly<{ kind: "success" }>
  | Readonly<{ kind: "usage"; code: string }>
  | Readonly<{ kind: "internal" }>;

export interface CommanderExecutionPolicy {
  configure(command: Command): void;
  classify(error: unknown): CommanderExitOutcome;
}

const SUCCESS_CODES = new Set(["commander.help", "commander.helpDisplayed", "commander.version"]);

const USAGE_CODES = new Set([
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.missingArgument",
  "commander.excessArguments",
  "commander.invalidArgument",
  "commander.conflictingOption",
  "commander.error",
]);

function isUnavailable(outcome: OutputWriteOutcome): boolean {
  return outcome.kind === "outputUnavailable";
}

export function createCommanderExecutionPolicy(
  supervisor: StreamSupervisor,
  onOutputUnavailable: () => void = () => {},
): CommanderExecutionPolicy {
  const notifyOutputUnavailable = (): void => {
    try {
      onOutputUnavailable();
    } catch {}
  };
  const enqueue = (sink: AwaitedOutputSink, text: string): void => {
    try {
      void sink.writeUtf8(text).then(
        (outcome) => {
          if (isUnavailable(outcome)) {
            notifyOutputUnavailable();
          }
        },
        () => {
          notifyOutputUnavailable();
        },
      );
    } catch {
      notifyOutputUnavailable();
    }
  };

  return {
    configure(command) {
      command.configureOutput({
        writeOut: (text) => {
          enqueue(supervisor.stdout, text);
        },
        writeErr: (text) => {
          enqueue(supervisor.stderr, text);
        },
        outputError: () => {},
      });
      command.exitOverride((error) => {
        throw error;
      });
    },
    classify(error) {
      try {
        if (!(error instanceof CommanderError)) {
          return { kind: "internal" };
        }
        const code = error.code;
        const exitCode = error.exitCode;
        if (typeof code !== "string" || !Number.isInteger(exitCode)) {
          return { kind: "internal" };
        }
        if (exitCode === 0 && SUCCESS_CODES.has(code)) {
          return { kind: "success" };
        }
        if (exitCode === 1 && USAGE_CODES.has(code)) {
          return { kind: "usage", code };
        }
      } catch {
        return { kind: "internal" };
      }
      return { kind: "internal" };
    },
  };
}
