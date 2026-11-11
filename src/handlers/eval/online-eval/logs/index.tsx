import z from "zod";
import type { AppIO } from "../../../../io";
import { flag } from "../../../../router";
import { createLogsHandler } from "../../../observability/logs";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createOnlineEvalLogsHandler = (core: Core, io: AppIO) =>
  createLogsHandler(io, {
    name: "logs",
    description: "stream or search online-eval logs",
    flags: [flag("id", "the ID of the online-eval resource", z.string().min(1))] as const,
    read: async (ctx, flags, request, signal) => {
      const options = coreOptsFromCtx(ctx);
      const source = await core.eval.resourceOnlineEvaluationLogSource(flags.id, options);

      if (request.mode === "search") {
        return {
          events: core.observability.searchLogs(source, request.query, options, signal),
        };
      }

      return {
        events: core.observability.tailLogs(source, request.query, options, signal),
        announcement: `Streaming logs for online-eval ${flags.id}... (Ctrl+C to stop)`,
      };
    },
  });
