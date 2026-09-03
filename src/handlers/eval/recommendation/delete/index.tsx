import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteRecommendationHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a recommendation by ID",
    flags: [flag("id", "the ID of the recommendation to delete", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.deleteRecommendation(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
