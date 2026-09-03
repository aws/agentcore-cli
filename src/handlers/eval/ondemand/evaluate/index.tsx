import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { EvaluationReferenceInput } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonArrayFlag } from "../../../utils";
import type { SessionWindow } from "../../types";

export const createEvaluateOnDemandHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions client-side (synchronous; prints scores)",
    flags: [
      flag(
        "agent",
        "source: harness ID or Runtime ID whose sessions to evaluate",
        z.string().optional(),
      ),
      flag("endpoint", "Runtime endpoint qualifier (default DEFAULT)", z.string().optional()),
      flag("evaluator", "evaluator ID(s) to apply", z.array(z.string()).optional()),
      flag(
        "lookback-days",
        "time filter: evaluate sessions from the last N days",
        z.number().optional(),
      ),
      flag(
        "start-time",
        "time filter: window start (ISO-8601, with --end-time)",
        z.string().optional(),
      ),
      flag(
        "end-time",
        "time filter: window end (ISO-8601, with --start-time)",
        z.string().optional(),
      ),
      flag("session-ids", "filter: specific session IDs", z.array(z.string()).optional()),
      flag(
        "trace-id",
        "filter: a single trace ID (session ID is read off the span)",
        z.string().optional(),
      ),
      flag(
        "ground-truth",
        "ground truth (JSON EvaluationReferenceInput[]; inline, file://<path>, or -)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["agent"]) {
        throw new InputValidationError("on-demand requires '--agent'");
      }
      if (!flags["evaluator"] || flags["evaluator"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }

      const window = resolveWindow(flags);
      const sessionIds = flags["session-ids"];
      const traceId = flags["trace-id"];
      // On-demand reads sessions client-side, so it needs a concrete source —
      // "evaluate everything" is not allowed.
      if (!window && !sessionIds?.length && !traceId) {
        throw new InputValidationError(
          "specify a session source: --session-ids, --trace-id, --lookback-days, or --start-time/--end-time",
        );
      }

      const opts = coreOptsFromCtx(ctx);
      const traces = await core.eval.getTracesForAgent(
        { agent: flags["agent"], endpoint: flags["endpoint"], window, sessionIds, traceId },
        opts,
      );

      // Ground truth is a typed SDK-shape passthrough (identical to batch's handler):
      // resolve inline / file:// / -, then hand the array to core verbatim — core
      // groups it by session.
      const resolver = new SourceResolver({ stdin: io.stdin });
      const groundTruth = parseJsonArrayFlag<EvaluationReferenceInput>(
        "ground-truth",
        await resolver.resolveText("ground-truth", flags["ground-truth"]),
      );

      const result = await core.eval.evaluate(
        { traces, evaluatorIds: flags["evaluator"], groundTruth },
        opts,
      );
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });

// resolveWindow validates on-demand's time filter: --lookback-days maps to
// [now - n days, now]; the explicit --start-time/--end-time pair must come together
// with start before end. On-demand owns this rather than reusing batch's resolver:
// batch has no --lookback-days and its window feeds a service-side data source, not
// a client-side Insights query.
function resolveWindow(flags: {
  "lookback-days"?: number;
  "start-time"?: string;
  "end-time"?: string;
}): SessionWindow | undefined {
  const lookback = flags["lookback-days"];
  const hasStart = flags["start-time"] !== undefined;
  const hasEnd = flags["end-time"] !== undefined;

  if (lookback !== undefined) {
    if (hasStart || hasEnd) {
      throw new InputValidationError(
        "--lookback-days cannot be combined with --start-time/--end-time",
      );
    }
    if (!Number.isFinite(lookback) || lookback <= 0) {
      throw new InputValidationError("--lookback-days must be a positive number");
    }
    const endTime = new Date();
    const startTime = new Date(+endTime - lookback * 24 * 60 * 60 * 1000);
    return { startTime, endTime };
  }

  if (!hasStart && !hasEnd) return undefined;
  if (!hasStart || !hasEnd) {
    throw new InputValidationError("--start-time and --end-time must be provided together");
  }
  const startTime = new Date(flags["start-time"]!);
  const endTime = new Date(flags["end-time"]!);
  if (Number.isNaN(+startTime) || Number.isNaN(+endTime)) {
    throw new InputValidationError("--start-time and --end-time must be ISO-8601 timestamps");
  }
  if (+startTime >= +endTime) {
    throw new InputValidationError("--start-time must be before --end-time");
  }
  return { startTime, endTime };
}
