import z from "zod";
import { createHandler, flag } from "../../../router";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonRendererKey } from "../../../tui";

export const createGetHarnessHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a harness",
    flags: [flag("id", "the ID of the harness", z.string().min(1).max(48))],
    handle: async (ctx, flags) => {
      const harness = await core.harness.getHarness(flags["id"], coreOptsFromCtx(ctx));
      ctx.require(JsonRendererKey).renderJson(harness);
    },
  });

export { HarnessGetScreen } from "./screen.tsx";
