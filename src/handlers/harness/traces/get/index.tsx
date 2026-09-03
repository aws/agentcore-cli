import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../../core/observability";
import type { AppIO } from "../../../../io";
import { flag } from "../../../../router";
import { resolveTraceOutputPath } from "../../../observability/traceOutputPath";
import { createGetTraceHandler } from "../../../observability/traces";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const harnessFlags = [
  flag("id", "the ID of the harness", z.string().min(1).max(48)),
  flag("qualifier", "the harness endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createGetHarnessTraceHandler = (core: Core, io: AppIO) =>
  createGetTraceHandler(io, {
    description: "download a harness trace's log records to a JSON file",
    flags: harnessFlags,
    read: async (ctx, flags, query, signal) => {
      const options = coreOptsFromCtx(ctx);
      const runtime = await core.harness.resolveRuntime(flags.id, options, signal);
      const source = {
        logGroupName: runtimeLogGroup(
          runtime.runtimeId,
          flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
        ),
      };
      return core.observability.getTrace(source, query, options, signal);
    },
    resolveOutputPath: (_ctx, _flags, request) => resolveTraceOutputPath(request),
  });
