import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListRuntimeVersionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a Runtime's versions",
    flags: [
      flag("id", "the ID of the Runtime", z.string().optional()),
      flag("next-token", "next token to use on paginated", z.string().optional()),
      flag("max-results", "max number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new TypeError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.runtime.listRuntimeVersions(
            flags.id,
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
