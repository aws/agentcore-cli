import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteGatewayTargetHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("target-id", "the Target ID", z.string().optional()),
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
          await core.gateway.deleteGatewayTarget(
            flags["gateway-id"],
            flags["target-id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
