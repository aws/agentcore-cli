import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetGatewayTargetHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a Gateway Target",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().min(1)),
      flag("target-id", "the ID of the Gateway Target", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.gateway.getGatewayTarget(
            flags["gateway-id"],
            flags["target-id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
