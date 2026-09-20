import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteGatewayRuleHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a Gateway Rule",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().min(1)),
      flag("rule-id", "the Rule ID", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
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
