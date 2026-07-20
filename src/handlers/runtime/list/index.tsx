import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export const createListRuntimesHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list AgentCore Runtimes",
    flags: [
      flag("next-token", "next token to use on paginated", z.string().optional()),
      flag("max-results", "max number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.runtime.listRuntimes(
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
