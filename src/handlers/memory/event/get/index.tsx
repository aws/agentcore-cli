import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { JsonRendererKey } from "../../../../tui";

export const createGetMemoryEventHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Memory Event",
    flags: [
      flag("memory", "the ID of the Memory", z.string()),
      flag("actor-id", "the ID of the actor", z.string()),
      flag("event-id", "the event ID", z.string()),
      flag("session-id", "the session ID", z.string()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.memory.getEvent(
        {
          memoryId: flags.memory,
          actorId: flags["actor-id"],
          sessionId: flags["session-id"],
          eventId: flags["event-id"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
