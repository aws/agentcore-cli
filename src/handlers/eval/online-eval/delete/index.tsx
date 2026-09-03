import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteOnlineEvalHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an online evaluation config by ID",
    flags: [flag("id", "the ID of the online evaluation config to delete", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.deleteOnlineEvaluationConfig(flags["id"], coreOptsFromCtx(ctx)),
        );
    },
  });
