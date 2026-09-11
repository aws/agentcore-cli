import { renderTui } from "../tui";
import type { AppIO } from "../io";
import type { Core } from "../handlers/types";
import { type Middleware } from "../router";
import { CommandKey } from "../router/router";
import { attributeName } from "../router/flags";
import { JsonKey } from "../handlers/keys";

export function withTuiOnEmptyFlagsAndArgs(core: Core, io: AppIO): Middleware {
  const boundRenderTui = renderTui(core, io);

  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const command = ctx.require(CommandKey);
      const noFlagsPassed = h
        .flags()
        .every((f) => command.getOptionValueSource(attributeName(f.name)) !== "cli");

      if (h.doesSupportTui() && !ctx.value(JsonKey) && noFlagsPassed && command.args.length === 0) {
        await boundRenderTui(ctx, flags, args);
        return;
      }
      await h.handle(ctx, flags, args);
    },
  });
}
