import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetOnlineEvalHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an online evaluation config by id",
    flags: [flag("id", "the ID of the online evaluation config", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.onlineEval.getOnlineEvaluationConfig(flags["id"], coreOptsFromCtx(ctx)),
        );
    },
  });
