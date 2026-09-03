import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetEvaluatorHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an evaluator by ID",
    flags: [flag("id", "the ID of the evaluator", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.getEvaluator(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
