import z from "zod";
import type {
  CloudWatchLogEvent,
  LogSearchQuery,
  LogTailQuery,
} from "../../core/observability/index";
import { InputValidationError } from "../../errors";
import type { AppIO } from "../../io";
import { createHandler, flag, type Context, type Flag } from "../../router";
import { withUserCancellation } from "../../runnable";
import { JsonRendererKey } from "../../tui";
import { JsonKey } from "../keys";
import { buildFilterPattern, LOG_LEVELS } from "./filterPattern";
import { resolveTimeWindow } from "./time";
import type { ResourceFlagValues } from "./types";

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

export type LogsReadRequest =
  | {
      mode: "search";
      query: LogSearchQuery;
    }
  | {
      mode: "tail";
      query: LogTailQuery;
    };

export type LogsReadResult = {
  events: AsyncIterable<CloudWatchLogEvent>;
  announcement?: string;
};

export function createLogsHandler<F extends readonly Flag<string, unknown>[]>(
  io: AppIO,
  config: {
    name: string;
    description: string;
    flags: F;
    read(
      ctx: Context,
      values: ResourceFlagValues<F> & LogFlagValues,
      request: LogsReadRequest,
      signal: AbortSignal,
    ): LogsReadResult | Promise<LogsReadResult>;
  },
) {
  const flags = [...config.flags, ...logFlags] as const;

  return createHandler({
    name: config.name,
    description: config.description,
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
      const writeEvent = (event: CloudWatchLogEvent) => {
        if (json) {
          renderer.renderJsonLine(event);
        } else {
          io.stdout.write(`${event.timestamp.toISOString()}  ${event.message.trimEnd()}\n`);
        }
      };

      await withUserCancellation(async (signal) => {
        const request: LogsReadRequest = searchMode
          ? {
              mode: "search",
              query: {
                startTimeMs,
                endTimeMs,
                filterPattern,
                limit: parsed.limit,
              },
            }
          : {
              mode: "tail",
              query: { filterPattern },
            };
        const result = await config.read(ctx, parsed, request, signal);
        if (result.announcement) io.stderr.write(`${result.announcement}\n`);
        for await (const event of result.events) writeEvent(event);
      });
    },
  });
}
