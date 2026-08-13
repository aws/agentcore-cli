import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export const createDeleteGatewayHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an AgentCore Gateway",
    flags: [flag("id", "the Gateway ID", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.deleteGateway(flags.id, coreOptsFromCtx(ctx)));
    },
  });
