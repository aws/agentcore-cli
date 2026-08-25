import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createResumeAbTestHandler = (core: Core) =>
  createHandler({
    name: "resume",
    description: "resume a paused A/B test",
    flags: [flag("id", "the ID of the A/B test", z.string().optional())],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      if (!id) throw new InputValidationError("required option '--id <id>' not specified");
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.setABTestExecutionStatus(id, "RUNNING", coreOptsFromCtx(ctx)));
    },
  });
