import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { InsightsJob } from "../insightsJob";

export const createListBatchInsightsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list batch insights runs",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of service items to inspect", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      const opts = coreOptsFromCtx(ctx);
      const response = await core.eval.listBatchEvaluations(
        flags["next-token"],
        flags["max-results"],
        opts,
      );

      ctx.require(JsonRendererKey).renderJson({
        ...response,
        batchEvaluations: (response.batchEvaluations ?? []).filter(InsightsJob.is),
      });
    },
  });

export { BatchInsightsListScreen } from "./screen.tsx";
