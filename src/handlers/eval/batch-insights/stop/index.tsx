import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createStopBatchInsightsHandler = (core: Core) =>
  createHandler({
    name: "stop",
    description: "stop a running batch insights run",
    flags: [flag("id", "the ID of the batch insights run to stop", z.string().optional())],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.stopBatchEvaluation(id, coreOptsFromCtx(ctx)));
    },
  });
