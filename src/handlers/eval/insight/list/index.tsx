import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

// The service requires at least one of --application-name or
// --batch-evaluation-id; its error is relayed unchanged.
export const createListInsightsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list Agent Insights for an application or a batch evaluation",
    flags: [
      flag(
        "application-name",
        "list the Insights of this application",
        z.string().min(1).optional(),
      ),
      flag(
        "batch-evaluation-id",
        "list the Insights a batch evaluation produced",
        z.string().min(1).optional(),
      ),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx.require(JsonRendererKey).renderJson(
        await core.eval.listAgentInsights(
          {
            applicationName: flags["application-name"],
            batchEvaluationId: flags["batch-evaluation-id"],
            nextToken: flags["next-token"],
            maxResults: flags["max-results"],
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
