import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteEvaluatorHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an evaluator by ID",
    flags: [flag("id", "the ID of the evaluator to delete", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.deleteEvaluator(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
