import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListBatchInsightsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list batch insights runs",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of batch insights runs to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.eval.listBatchInsights(
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { BatchInsightsListScreen } from "./screen.tsx";
