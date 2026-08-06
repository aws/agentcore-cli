import { Option, type Command } from "commander";
import { renderTui } from "../tui";
import { JsonKey } from "../handlers/keys";
import type { AppIO } from "../io";
import type { Core } from "../handlers/types";
import { CommandKey, isTuiCommandSupported, type Handler, type Middleware } from "../router";

// countPassedValues counts how many entries of an object hold a defined value.
const countPassedValues = (obj: object) =>
  Object.entries(obj).reduce((acc, [_key, val]) => {
    if (val !== undefined) {
      acc += 1;
    }

    return acc;
  }, 0);

// countPassedFlags counts the leaf's own flags the user actually supplied on
// the command line. The parsed flags object can't be used for this: schema
// (and Commander boolean) defaults arrive there as defined values, which would
// make a leaf with defaulted flags look non-empty on a bare invocation.
const countPassedFlags = (h: Handler, command: Command) =>
  h.flags().filter((f) => {
    const attribute = new Option(`--${f.name}`).attributeName();
    return command.getOptionValueSource(attribute) === "cli";
  }).length;

// withTuiOnEmptyFlagsAndArgs opens the interactive TUI when a leaf command is
// invoked with no flags or arguments (and not in JSON mode); otherwise it
// delegates to the wrapped handler.
export function withTuiOnEmptyFlagsAndArgs(core: Core, io: AppIO): Middleware {
  const boundRenderTui = renderTui(core, io);

  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const command = ctx.require(CommandKey);
      if (
        isTuiCommandSupported(command) &&
        !ctx.require(JsonKey) &&
        countPassedFlags(h, command) === 0 &&
        countPassedValues(args) === 0
      ) {
        await boundRenderTui(ctx, flags, args);
        return;
      } else {
        await h.handle(ctx, flags, args);
      }
    },
  });
}
