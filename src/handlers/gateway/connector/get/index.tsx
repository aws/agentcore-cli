import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetGatewayConnectorHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a connector configured for an AgentCore Gateway",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().optional()),
      flag("id", "the ID of the connector-backed Gateway Target", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const target = await core.gateway.getGatewayConnector(
        flags["gateway-id"],
        flags.id,
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(target);
    },
  });
