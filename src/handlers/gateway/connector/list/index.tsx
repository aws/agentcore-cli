import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListGatewayConnectorsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list connectors configured for an AgentCore Gateway",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().min(1)),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.gateway.listGatewayConnectors(
        flags["gateway-id"],
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
