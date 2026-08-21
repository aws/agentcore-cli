import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createPauseOnlineInsightHandler = (core: Core) =>
  createHandler({
    name: "pause",
    description: "pause an online insight config",
    flags: [flag("id", "the ID of the online insight config to pause", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.setOnlineInsightExecutionStatus(
            flags["id"],
            "DISABLED",
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
