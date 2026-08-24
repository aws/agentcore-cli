import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { InsightsJob } from "../insightsJob";

export const createGetBatchInsightsHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a batch insights run and its reports by id",
    flags: [flag("id", "the ID of the batch insights run", z.string().optional())],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");

      const opts = coreOptsFromCtx(ctx);
      const { detail } = await core.eval.getBatchEvaluation(id, opts, {
        includeResults: false,
      });
      InsightsJob.assert(detail, id);

      ctx.require(JsonRendererKey).renderJson(detail);
    },
  });

export { BatchInsightsGetJsonScreen } from "./screen.tsx";
