import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetRecommendationHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a recommendation by ID",
    flags: [flag("id", "the ID of the recommendation", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.getRecommendation(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
