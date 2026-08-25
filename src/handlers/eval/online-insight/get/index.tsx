import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetOnlineInsightHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an online insight config by id",
    flags: [flag("id", "the ID of the online insight config", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.getOnlineInsight(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
