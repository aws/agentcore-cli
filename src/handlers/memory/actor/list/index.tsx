import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListMemoryActorsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list actors in an AgentCore Memory",
    flags: [
      flag("id", "the ID of the Memory", z.string().min(1)),
      flag("max-results", "maximum number of actors to return", z.number().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.memory.listActors(
        {
          memoryId: flags.id,
          maxResults: flags["max-results"],
          nextToken: flags["next-token"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
