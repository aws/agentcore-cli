import { gatewayIdSchema } from "../invoke/request";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export const createGetGatewayHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Gateway",
    flags: [flag("id", "the ID of the Gateway", gatewayIdSchema.min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.getGateway(flags.id, coreOptsFromCtx(ctx)));
    },
  });
