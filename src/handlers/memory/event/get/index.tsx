import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { JsonRendererKey } from "../../../../tui";

export const createGetMemoryEventHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Memory Event",
    flags: [
      flag("id", "the ID of the Memory", z.string().optional()),
      flag("actor-id", "the ID of the actor", z.string().optional()),
      flag("event-id", "the event ID", z.string().optional()),
      flag("session-id", "the session ID", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["actor-id"]) {
        throw new InputValidationError("required option '--actor-id <actor-id>' not specified");
      }
      if (!flags["session-id"]) {
        throw new InputValidationError("required option '--session-id <session-id>' not specified");
      }
      if (!flags["event-id"]) {
        throw new InputValidationError("required option '--event-id <event-id>' not specified");
      }

      const response = await core.memory.getEvent(
        {
          memoryId: flags.id,
          actorId: flags["actor-id"],
          sessionId: flags["session-id"],
          eventId: flags["event-id"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
