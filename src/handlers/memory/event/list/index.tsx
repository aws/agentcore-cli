import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { JsonRendererKey } from "../../../../tui";
import { parseEventMetadataFilters } from "../../metadataFilters";

export const createListMemoryEventsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list AgentCore Memory events",
    flags: [
      flag("id", "the ID of the Memory", z.string().min(1)),
      flag("actor-id", "the ID of the actor", z.string().min(1)),
      flag("session-id", "the session ID", z.string().min(1)),
      flag("include-payloads", "includes event payloads in the response", z.boolean().optional()),
      flag("branch", "filter events by branch name", z.string().optional()),
      flag(
        "include-parent-branches",
        "includes parent branches when filtering by branch",
        z.boolean().optional(),
      ),
      flag("metadata-filters", "event metadata filters as JSON", z.string().optional()),
      flag("max-results", "maximum number of events to return; default 20", z.number().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
    ],

    handle: async (ctx, flags) => {
      if (flags["include-parent-branches"] && !flags.branch) {
        throw new InputValidationError("'--include-parent-branches' requires '--branch'");
      }

      const eventMetadata = parseEventMetadataFilters(flags["metadata-filters"]);
      const filter =
        flags.branch || eventMetadata
          ? {
              branch: flags.branch
                ? {
                    name: flags.branch,
                    includeParentBranches: flags["include-parent-branches"],
                  }
                : undefined,
              eventMetadata,
            }
          : undefined;

      const response = await core.memory.listEvents(
        {
          memoryId: flags.id,
          actorId: flags["actor-id"],
          sessionId: flags["session-id"],
          includePayloads: flags["include-payloads"],
          filter,
          maxResults: flags["max-results"],
          nextToken: flags["next-token"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
