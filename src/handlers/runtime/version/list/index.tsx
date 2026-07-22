import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { withoutSdkMetadata } from "../../withoutSdkMetadata";

export const createListRuntimeVersionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a Runtime's versions",
    flags: [
      flag("id", "the ID of the Runtime", z.string().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new TypeError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          withoutSdkMetadata(
            await core.runtime.listRuntimeVersions(
              flags.id,
              flags["next-token"],
              flags["max-results"],
              coreOptsFromCtx(ctx),
            ),
          ),
        );
    },
  });
