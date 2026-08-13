import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { GatewayConnectorTarget } from "../gatewayConnectorTarget";

export const createDeleteGatewayConnectorHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a connector-backed Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("id", "the connector-backed Gateway Target ID", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const options = coreOptsFromCtx(ctx);
      const target = await core.gateway.getGatewayTarget(flags["gateway-id"], flags.id, options);
      if (!GatewayConnectorTarget.is(target.targetConfiguration)) {
        throw new InputValidationError(`Gateway Target "${flags.id}" is not connector-backed`);
      }
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.deleteGatewayTarget(flags["gateway-id"], flags.id, options));
    },
  });
