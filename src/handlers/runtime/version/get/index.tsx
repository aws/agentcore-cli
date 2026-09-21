import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetRuntimeVersionHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a specific Runtime version",
    flags: [
      flag("id", "the ID of the Runtime", z.string().min(1)),
      flag("version", "the Runtime version to get", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.runtime.getRuntimeVersion(flags.id, flags.version, coreOptsFromCtx(ctx)),
        );
    },
  });
