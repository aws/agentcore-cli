import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetInsightStoreHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an Agent Insight Store by ID",
    flags: [flag("id", "the ID of the Agent Insight Store", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.getAgentInsightStore(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
