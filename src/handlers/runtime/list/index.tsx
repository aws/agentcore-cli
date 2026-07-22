import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { withoutSdkMetadata } from "../withoutSdkMetadata";

export const createListRuntimesHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list AgentCore Runtimes",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          withoutSdkMetadata(
            await core.runtime.listRuntimes(
              flags["next-token"],
              flags["max-results"],
              coreOptsFromCtx(ctx),
            ),
          ),
        );
    },
  });
