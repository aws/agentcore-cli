import { CommandKey, type DefaultHandle } from "../router";
import type { AppIO } from "./types";

export function createHelpDefault(io: AppIO): DefaultHandle {
  return async (ctx) => {
    const help = ctx.require(CommandKey).helpInformation();
    io.stdout.write(help.endsWith("\n") ? help : `${help}\n`);
  };
}
