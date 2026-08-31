import z from "zod";
import { parseTimeString } from "../../../core/observability";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag } from "../../../router";
import { withUserCancellation } from "../../../runnable";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { runtimeIdSchema } from "../invoke/request";
import { resolveRuntimeTarget } from "../resolveRuntimeTarget";
import type { RuntimeLogEvent } from "../types";
import { buildFilterPattern, LOG_LEVELS } from "./filterPattern";

// Search mode's default window when only one bound is given: the last hour.
const DEFAULT_SEARCH_WINDOW_MS = 3_600_000;

const levelSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(LOG_LEVELS),
  )
  .optional();

const timeSchema = z.string().min(1).optional();

/**
 * `runtime logs` follows a deployed runtime's CloudWatch log group live
 * (default), or searches a past time window when --since/--until is given.
 * Follow mode runs until Ctrl+C, which exits with the conventional SIGINT
 * status (130).
 */
export const createRuntimeLogsHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "logs",
    description: "stream or search a Runtime's logs",
    flags: [
      flag(
        "id",
        "the ID of the Runtime (defaults to the project's deployed runtime)",
        runtimeIdSchema.optional(),
      ),
      flag(
        "since",
        'search window start: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default 1h ago; enables search mode)',
        timeSchema,
      ),
      flag(
        "until",
        'search window end: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default now; enables search mode)',
        timeSchema,
      ),
      flag("level", `filter by log level (${LOG_LEVELS.join(", ")})`, levelSchema),
      flag("query", "server-side text filter", z.string().optional()),
      flag(
        "limit",
        "maximum number of log lines to return (search mode)",
        z.number().int().positive().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const json = ctx.require(JsonKey);
      const renderer = ctx.require(JsonRendererKey);

      // --since / --until switch from live tail to a bounded search.
      const searchMode = flags.since !== undefined || flags.until !== undefined;
      if (!searchMode && flags.limit !== undefined) {
        throw new InputValidationError(
          "--limit applies to search mode; add --since and/or --until",
        );
      }
      const filterPattern = buildFilterPattern({ level: flags.level, query: flags.query });
      const startTimeMs =
        flags.since !== undefined
          ? parseTimeString(flags.since)
          : Date.now() - DEFAULT_SEARCH_WINDOW_MS;
      const endTimeMs = flags.until !== undefined ? parseTimeString(flags.until) : Date.now();

      const writeEvent = (event: RuntimeLogEvent) => {
        const timestamp = new Date(event.timestamp).toISOString();
        if (json) {
          renderer.renderJsonLine({ timestamp, message: event.message });
        } else {
          io.stdout.write(`${timestamp}  ${event.message.trimEnd()}\n`);
        }
      };

      await withUserCancellation(async (signal) => {
        const target = await resolveRuntimeTarget(core, ctx, flags.id);

        if (searchMode) {
          const events = core.observability.searchRuntimeLogs(
            {
              runtimeId: target.runtimeId,
              startTimeMs,
              endTimeMs,
              filterPattern,
              limit: flags.limit,
            },
            target.options,
            signal,
          );
          for await (const event of events) writeEvent(event);
          return;
        }

        io.stderr.write(`Streaming logs for runtime ${target.runtimeId}... (Ctrl+C to stop)\n`);
        const events = core.observability.streamRuntimeLogs(
          { runtimeId: target.runtimeId, filterPattern },
          target.options,
          signal,
        );
        for await (const event of events) writeEvent(event);
      });
    },
  });
