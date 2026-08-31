import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import z from "zod";
import { sanitizeQueryValue } from "../../../../core/observability";
import {
  FileWriteError,
  InputValidationError,
  ResourceNotFoundError,
  ResultTruncationError,
} from "../../../../errors";
import type { AppIO } from "../../../../io";
import { argument, createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import { resolveTimeWindow } from "../../../observability/time";
import type { Core } from "../../../types";
import { runtimeIdSchema } from "../../invoke/request";
import { resolveRuntimeTarget } from "../../resolveRuntimeTarget";
import type { TraceRecord } from "../../types";
import { DEFAULT_TRACES_WINDOW_MS } from "../index";
import { resolveTraceOutputPath } from "./outputPath";

const TRACE_ID_PATTERN = /^[a-fA-F0-9-]+$/;
const TRACE_RECORD_LIMIT = 10_000;

export const createGetRuntimeTraceHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "get",
    description: "download a trace's log records to a JSON file",
    arguments: [argument("trace-id", "the trace ID to download", z.string().min(1))],
    flags: [
      flag(
        "id",
        "the ID of the Runtime (defaults to the project's deployed runtime)",
        runtimeIdSchema.optional(),
      ),
      flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
      flag(
        "output",
        "the output file path (default: agentcore/.cli/traces/<runtime>-<traceId>.json in a project)",
        z.string().min(1, "requires a nonempty path").optional(),
      ),
      flag(
        "since",
        'window start: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default 12h ago)',
        z.string().min(1).optional(),
      ),
      flag(
        "until",
        'window end: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default now)',
        z.string().min(1).optional(),
      ),
    ],
    handle: async (ctx, flags, args) => {
      const traceId = args["trace-id"];
      if (!TRACE_ID_PATTERN.test(traceId)) {
        throw new InputValidationError(
          "Invalid trace ID format. Expected a hex string (e.g., abc123def456).",
          { meta: { traceId } },
        );
      }
      const { startTimeMs, endTimeMs } = resolveTimeWindow({
        since: flags.since,
        until: flags.until,
        defaultWindowMs: DEFAULT_TRACES_WINDOW_MS,
      });

      const target = await resolveRuntimeTarget(core, ctx, flags.id);
      const queryString =
        `fields @timestamp, @message\n` +
        `| filter traceId = '${sanitizeQueryValue(traceId)}'\n` +
        `| sort @timestamp asc\n` +
        `| limit ${TRACE_RECORD_LIMIT}`;
      const rows = await core.observability.queryLogs(
        {
          kind: "runtime",
          id: target.runtimeId,
          ...(flags.qualifier ? { qualifier: flags.qualifier } : {}),
        },
        {
          queryString,
          startTimeMs,
          endTimeMs,
          rowLimit: {
            maxRows: TRACE_RECORD_LIMIT,
            buildError: (maxRows) =>
              new ResultTruncationError(
                `Trace ${traceId} contains at least ${maxRows} records; narrow --since/--until`,
              ),
          },
        },
        target.options,
      );
      if (rows.length === 0) {
        throw new ResourceNotFoundError(`No trace data found for trace ID: ${traceId}`, {
          meta: { traceId },
        });
      }
      const records: TraceRecord[] = rows.map((row) => {
        const record: TraceRecord = { ...row };
        const message = record["@message"];
        if (typeof message === "string") {
          try {
            record["@message"] = JSON.parse(message);
          } catch {
            // Keep non-JSON messages unchanged.
          }
        }
        return record;
      });

      const filePath = resolveTraceOutputPath({
        output: flags.output,
        project: target.project,
        runtimeId: target.runtimeId,
        traceId,
      });
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(records, null, 2));
      } catch (error) {
        throw new FileWriteError(
          `Could not write the trace file at ${filePath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error, meta: { filePath } },
        );
      }

      if (ctx.require(JsonKey)) {
        ctx.require(JsonRendererKey).renderJson({ filePath, recordCount: records.length });
        return;
      }
      io.stderr.write(`Saved ${records.length} records for trace ${traceId}\n`);
      io.stdout.write(`${filePath}\n`);
    },
  });
