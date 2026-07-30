import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createResumeOnlineEvalHandler = (core: Core) =>
  createHandler({
    name: "resume",
    description: "resume a paused online evaluation config",
    flags: [flag("id", "the ID of the online evaluation config to resume", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.setOnlineEvaluationExecutionStatus(
            flags["id"],
            "ENABLED",
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
