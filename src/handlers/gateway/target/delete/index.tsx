import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteGatewayTargetHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().min(1)),
      flag("target-id", "the Target ID", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.gateway.deleteGatewayTarget(
            flags["gateway-id"],
            flags["target-id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
