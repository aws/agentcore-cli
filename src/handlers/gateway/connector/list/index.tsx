import { TargetType } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListGatewayConnectorsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list connectors configured for an AgentCore Gateway",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }

      const response = await core.gateway.listGatewayTargets(
        flags["gateway-id"],
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson({
        ...response,
        items: response.items?.filter((target) => target.targetType === TargetType.CONNECTOR),
      });
    },
  });
