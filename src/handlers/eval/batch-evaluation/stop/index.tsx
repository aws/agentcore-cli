import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createStopBatchEvaluationHandler = (core: Core) =>
  createHandler({
    name: "stop",
    description: "stop a running batch evaluation",
    flags: [flag("id", "the ID of the batch evaluation to stop", z.string())],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.stopBatchEvaluation(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
