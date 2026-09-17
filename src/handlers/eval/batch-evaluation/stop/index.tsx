import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createStopBatchEvaluationHandler = (core: Core) =>
  createHandler({
    name: "stop",
    description: "stop a running batch evaluation",
    flags: [flag("id", "the ID of the batch evaluation to stop", z.string().optional())],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.stopBatchEvaluation(id, coreOptsFromCtx(ctx)));
    },
  });
