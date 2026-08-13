import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteGatewayRuleHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a Gateway Rule",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional()),
      flag("rule-id", "the Rule ID", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags["rule-id"]) {
        throw new InputValidationError("required option '--rule-id <rule-id>' not specified");
      }
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.gateway.deleteGatewayRule(
            flags["gateway-id"],
            flags["rule-id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
