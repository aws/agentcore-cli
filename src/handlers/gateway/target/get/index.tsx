import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetGatewayTargetHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a Gateway Target",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().optional()),
      flag("target-id", "the ID of the Gateway Target", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags["target-id"]) {
        throw new InputValidationError("required option '--target-id <target-id>' not specified");
      }

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
