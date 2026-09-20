import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetRuntimeEndpointHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a Runtime endpoint",
    flags: [
      flag("id", "the ID of the Runtime", z.string().min(1)),
      flag("qualifier", "the endpoint name (qualifier)", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.runtime.getRuntimeEndpoint(flags.id, flags.qualifier, coreOptsFromCtx(ctx)),
        );
    },
  });
