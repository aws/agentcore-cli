import { createHandler } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { InsightTarget } from "../insightTarget";

export const createGetInsightHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an Agent Insight with its root causes and sample sessions",
    flags: [...InsightTarget.flags],
    handle: async (ctx, flags) => {
      const { applicationName, agentInsightId } = InsightTarget.resolve(flags);
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.getAgentInsight(applicationName, agentInsightId, coreOptsFromCtx(ctx)),
        );
    },
  });
