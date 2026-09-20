import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export const createDeleteGatewayHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an AgentCore Gateway",
    flags: [flag("id", "the Gateway ID", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.deleteGateway(flags.id, coreOptsFromCtx(ctx)));
    },
  });
