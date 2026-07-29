import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export const createGetRuntimeHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Runtime",
    flags: [flag("id", "the ID of the Runtime", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.runtime.getRuntime(flags.id, coreOptsFromCtx(ctx)));
    },
  });
