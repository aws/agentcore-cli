import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetRuntimeEndpointHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a Runtime endpoint",
    flags: [
      flag("id", "the ID of the Runtime", z.string().optional()),
      flag("qualifier", "the endpoint name (qualifier)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags.qualifier) {
        throw new InputValidationError("required option '--qualifier <qualifier>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.runtime.getRuntimeEndpoint(flags.id, flags.qualifier, coreOptsFromCtx(ctx)),
        );
    },
  });
