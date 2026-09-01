import z from "zod";
import type {
  CoreObservabilityClient,
  LogRecord,
  ObservableResourceRef,
} from "../../core/observability";
import { InputValidationError } from "../../errors";
import type { AppIO } from "../../io";
import { createHandler, flag, type Flag } from "../../router";
import { withUserCancellation } from "../../runnable";
import { JsonRendererKey } from "../../tui";
import { JsonKey } from "../keys";
import { coreOptsFromCtx } from "../utils";
import { buildFilterPattern, LOG_LEVELS } from "./filterPattern";
import { resolveTimeWindow } from "./time";
import type { ObservableResourceCommand, ResourceFlagValues } from "./types";

const DEFAULT_SEARCH_WINDOW_MS = 3_600_000;

const levelSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(LOG_LEVELS),
  )
  .optional();

const logFlags = [
  flag(
    "since",
    'search window start: "5m", "1h", ISO 8601, epoch ms, or "now"',
    z.string().min(1).optional(),
  ),
  flag(
    "until",
    'search window end: "5m", "1h", ISO 8601, epoch ms, or "now"',
    z.string().min(1).optional(),
  ),
  flag("tail", "tail new log records", z.boolean().default(false)),
  flag("level", `filter by log level (${LOG_LEVELS.join(", ")})`, levelSchema),
  flag("query", "CloudWatch Logs filter pattern", z.string().optional()),
  flag(
    "limit",
    "maximum number of log records to return in search mode",
    z.number().int().positive().optional(),
  ),
] as const;

type LogFlagValues = ResourceFlagValues<typeof logFlags>;

/**
 * Builds reusable logs command behavior. Primitive routers contribute only
 * identity flags and conversion to an ObservableResourceRef.
 */
export function createLogsHandler<
  K extends ObservableResourceRef["kind"],
  F extends readonly Flag<string, unknown>[],
>(client: CoreObservabilityClient, io: AppIO, resourceCommand: ObservableResourceCommand<K, F>) {
  const flags = [...resourceCommand.flags, ...logFlags] as const;

  return createHandler({
    name: "logs",
    description: "stream or search resource logs",
    flags,
    handle: async (ctx, values) => {
      const parsed = values as unknown as ResourceFlagValues<F> & LogFlagValues;
      const searchMode = parsed.since !== undefined || parsed.until !== undefined;
      if (parsed.tail && searchMode) {
        throw new InputValidationError("--tail cannot be combined with --since or --until");
      }
      if (!searchMode && parsed.limit !== undefined) {
        throw new InputValidationError(
          "--limit applies to search mode; add --since and/or --until",
        );
      }

      const filterPattern = buildFilterPattern({
        level: parsed.level,
        query: parsed.query,
      });
      const { startTimeMs, endTimeMs } = resolveTimeWindow({
        since: parsed.since,
        until: parsed.until,
        defaultWindowMs: DEFAULT_SEARCH_WINDOW_MS,
      });

      const json = ctx.require(JsonKey);
      const renderer = ctx.require(JsonRendererKey);
      const writeRecord = (record: LogRecord) => {
        if (json) {
          renderer.renderJsonLine(record);
        } else {
          io.stdout.write(`${record.timestamp.toISOString()}  ${record.message.trimEnd()}\n`);
        }
      };

      await withUserCancellation(async (signal) => {
        const target = await resourceCommand.resolve(parsed, ctx);
        const { resource } = target;
        const options = target.options ?? coreOptsFromCtx(ctx);
        if (searchMode) {
          const records = client.searchLogs(
            resource,
            {
              startTimeMs,
              endTimeMs,
              filterPattern,
              limit: parsed.limit,
            },
            options,
            signal,
          );
          for await (const record of records) writeRecord(record);
          return;
        }

        io.stderr.write(`Streaming logs for ${resource.kind} ${resource.id}... (Ctrl+C to stop)\n`);
        const records = client.tailLogs(resource, { filterPattern }, options, signal);
        for await (const record of records) writeRecord(record);
      });
    },
  });
}
