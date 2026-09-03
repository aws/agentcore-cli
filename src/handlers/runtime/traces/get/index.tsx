import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../../core/observability";
import type { AppIO } from "../../../../io";
import { flag } from "../../../../router";
import { createGetTraceHandler } from "../../../observability/traces";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { runtimeIdSchema } from "../../invoke/request";
import { resolveTraceOutputPath } from "../outputPath";

const runtimeFlags = [
  flag("id", "the ID of the Runtime", runtimeIdSchema),
  flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createGetRuntimeTraceHandler = (core: Core, io: AppIO) =>
  createGetTraceHandler(io, {
    description: "download a trace's log records to a JSON file",
    flags: runtimeFlags,
    read: (ctx, flags, query, signal) => {
      const source = {
        logGroupName: runtimeLogGroup(flags.id, flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER),
      };
      return core.observability.getTrace(source, query, coreOptsFromCtx(ctx), signal);
    },
    resolveOutputPath: (_ctx, _flags, request) => resolveTraceOutputPath(request),
  });
