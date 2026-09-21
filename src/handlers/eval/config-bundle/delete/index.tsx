import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteConfigBundleHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a configuration bundle and all of its versions",
    flags: [flag("id", "the ID of the configuration bundle", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.deleteConfigurationBundle(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
