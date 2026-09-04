import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../core/observability";
import type { AppIO } from "../../../io";
import { flag } from "../../../router";
import { createLogsHandler } from "../../observability/logs";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { runtimeIdSchema } from "../invoke/request";

const runtimeFlags = [
  flag("id", "the ID of the Runtime", runtimeIdSchema),
  flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
] as const;

/**
 * `runtime logs` follows a deployed runtime's CloudWatch log group live
 * (default), or searches a past time window when --since/--until is given.
 * Follow mode runs until Ctrl+C, which exits with the conventional SIGINT
 * status (130).
 */
export const createRuntimeLogsHandler = (core: Core, io: AppIO) =>
  createLogsHandler(io, {
    description: "stream or search a Runtime's logs",
    flags: runtimeFlags,
    read: (ctx, flags, request, signal) => {
      const options = coreOptsFromCtx(ctx);
      const source = {
        logGroupName: runtimeLogGroup(flags.id, flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER),
      };

      if (request.mode === "search") {
        return {
          events: core.observability.searchLogs(source, request.query, options, signal),
        };
      }

      return {
        events: core.observability.tailLogs(source, request.query, options, signal),
        announcement: `Streaming logs for runtime ${flags.id}... (Ctrl+C to stop)`,
      };
    },
  });
