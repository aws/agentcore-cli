import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetGatewayRuleHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a Gateway Rule",
    flags: [
      flag("gateway-id", "the ID of the Gateway", z.string().min(1)),
      flag("rule-id", "the ID of the Gateway Rule", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.gateway.getGatewayRule(
            flags["gateway-id"],
            flags["rule-id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
