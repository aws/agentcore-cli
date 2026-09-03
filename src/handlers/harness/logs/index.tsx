import z from "zod";
import { DEFAULT_ENDPOINT_QUALIFIER, runtimeLogGroup } from "../../../core/observability";
import type { AppIO } from "../../../io";
import { flag } from "../../../router";
import { createLogsHandler } from "../../observability/logs";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

const harnessFlags = [
  flag("id", "the ID of the harness", z.string().min(1).max(48)),
  flag("qualifier", "the harness endpoint qualifier", z.string().min(1).optional()),
] as const;

export const createHarnessLogsHandler = (core: Core, io: AppIO) =>
  createLogsHandler(io, {
    description: "stream or search a harness's logs",
    flags: harnessFlags,
    read: async (ctx, flags, request, signal) => {
      const options = coreOptsFromCtx(ctx);
      const runtime = await core.harness.resolveRuntime(flags.id, options, signal);
      const source = {
        logGroupName: runtimeLogGroup(
          runtime.runtimeId,
          flags.qualifier ?? DEFAULT_ENDPOINT_QUALIFIER,
        ),
      };

      if (request.mode === "search") {
        return {
          events: core.observability.searchLogs(source, request.query, options, signal),
        };
      }

      return {
        events: core.observability.tailLogs(source, request.query, options, signal),
        announcement: `Streaming logs for harness ${flags.id}... (Ctrl+C to stop)`,
      };
    },
  });
