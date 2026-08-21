import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListOnlineInsightHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list online insight configs",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.eval.listOnlineInsights(
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
