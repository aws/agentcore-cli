import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetRecommendationHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a recommendation by ID",
    flags: [flag("id", "the ID of the recommendation", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.getRecommendation(flags["id"], coreOptsFromCtx(ctx)));
    },
  });

export { RecommendationGetJsonScreen } from "./screen.tsx";
