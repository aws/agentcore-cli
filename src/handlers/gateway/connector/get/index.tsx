import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetGatewayConnectorHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a connector-backed Gateway Target",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().min(1)),
      flag("id", "the ID of the connector-backed Gateway Target", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const target = await core.gateway.getGatewayConnector(
        flags["gateway-id"],
        flags.id,
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(target);
    },
  });
