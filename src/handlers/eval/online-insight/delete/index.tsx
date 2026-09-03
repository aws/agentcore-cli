import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteOnlineInsightHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an online insight config by ID",
    flags: [flag("id", "the ID of the online insight config to delete", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.deleteOnlineInsight(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
