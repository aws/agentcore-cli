import { type Command, Argument as CommanderArgument } from "commander";
import type { Argument } from "./handler";
import { coerce, formatZodError, inspect } from "./schema";

export function toCommanderArgument(arg: Argument): CommanderArgument {
  const info = inspect(arg.schema);
  // Commander treats <> as required and [] as optional: https://github.com/tj/commander.js#more-configuration-1
  // Variadic arguments use trailing ... syntax: https://github.com/tj/commander.js#command-arguments
  const inner = info.variadic ? `${arg.name}...` : arg.name;
  const name = info.required ? `<${inner}>` : `[${inner}]`;
  const commanderArg = new CommanderArgument(name, arg.description);

  if (info.hasDefault) {
    commanderArg.default(info.defaultValue);
  }

  return commanderArg;
}

function validateArgument(
  argument: Argument,
  input: unknown | undefined,
  _command: Command,
): unknown {
  const result = argument.schema.safeParse(coerce(argument.schema, input));
  if (!result.success) {
    throw new TypeError(
      `Invalid value for argument '${argument.name}': ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function parseArguments(
  expectedArguments: Argument[],
  command: Command,
): Record<string, unknown> {
  const inputArguments = command.processedArgs;
  const out: Record<string, unknown> = {};

  for (let index = 0; index < expectedArguments.length; index++) {
    const currentArg = inputArguments[index];
    // should never be undefined based on loop bound
    const expectedArg = expectedArguments[index]!;

    out[expectedArg.name] = validateArgument(expectedArg, currentArg, command);
  }

  return out;
}
