import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import z from "zod";
import { parseTimeString } from "../../../../core/observability";
import { FileWriteError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { argument, createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import type { Core } from "../../../types";
import { runtimeIdSchema } from "../../invoke/request";
import { resolveRuntimeTarget } from "../../resolveRuntimeTarget";
import { DEFAULT_TRACES_WINDOW_MS } from "../index";
import { resolveTraceOutputPath } from "./outputPath";

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
      const startTimeMs =
        flags.since !== undefined
          ? parseTimeString(flags.since)
          : Date.now() - DEFAULT_TRACES_WINDOW_MS;
      const endTimeMs = flags.until !== undefined ? parseTimeString(flags.until) : Date.now();

      const target = await resolveRuntimeTarget(core, ctx, flags.id);
      const records = await core.observability.getRuntimeTrace(
        { runtimeId: target.runtimeId, traceId, startTimeMs, endTimeMs },
        target.options,
      );

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
