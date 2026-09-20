import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createGetVersionHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a specific version of a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("version", "the harness version to get", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const harness = await core.harness.getHarnessVersion(
        flags["id"],
        flags["version"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(harness);
    },
  });

export { HarnessGetVersionScreen } from "./screen.tsx";
