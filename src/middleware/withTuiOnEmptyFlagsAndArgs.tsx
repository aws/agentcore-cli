import { renderTui } from "../tui";
import { JsonKey } from "../handlers/keys";
import type { AppIO, Core } from "../handlers/types";
import { type Middleware } from "../router";

// countPassedValues counts how many entries of an object hold a defined value.
const countPassedValues = (obj: object) =>
  Object.entries(obj).reduce((acc, [_key, val]) => {
    if (val !== undefined) {
      acc += 1;
    }

    return acc;
  }, 0);

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
      if (
        !ctx.require(JsonKey) &&
        countPassedValues(flags) === 0 &&
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
