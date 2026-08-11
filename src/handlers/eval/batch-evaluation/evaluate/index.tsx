import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { SessionMetadataShape, DataSourceConfig } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import type { SessionSourceValue, SessionWindow } from "../../types";

export const createEvaluateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions service-side (async; returns a job id)",
    flags: [
      flag(
        "agent",
        "source: harness id or runtime id whose sessions to evaluate",
        z.string().optional(),
      ),
      flag(
        "endpoint",
        "runtime endpoint qualifier (default DEFAULT; only with --agent)",
        z.string().optional(),
      ),
      flag(
        "online-eval",
        "source: evaluate sessions an online-eval config already sampled",
        z.string().optional(),
      ),
      flag(
        "data-source-config",
        "source: raw DataSourceConfig JSON (inline, file://<path>, or -); escape hatch",
        z.string().optional(),
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
      flag(
        "session-ids",
        "filter: specific session ids (only with --agent)",
        z.array(z.string()).optional(),
      ),
      flag("evaluator", "evaluator id(s) to apply", z.array(z.string()).optional()),
      flag(
        "ground-truth",
        "session ground truth (JSON SessionMetadataShape[]; inline, file://<path>, or -)",
        z.string().optional(),
      ),
      flag("name", "batch evaluation name (must be unique in the account)", z.string().optional()),
      flag("description", "optional description", z.string().optional()),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["evaluator"] || flags["evaluator"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      const rawDataSourceConfig = parseJsonFlag<DataSourceConfig>(
        "data-source-config",
        await resolver.resolveText("data-source-config", flags["data-source-config"]),
      );
      const source = resolveDataSource(flags, rawDataSourceConfig);

      const groundTruth = parseJsonFlag<SessionMetadataShape[]>(
        "ground-truth",
        await resolver.resolveText("ground-truth", flags["ground-truth"]),
      );

      const response = await core.eval.startBatchEvaluation(
        {
          name: flags["name"],
          description: flags["description"],
          evaluatorIds: flags["evaluator"],
          source,
          groundTruth,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

type SourceFlags = {
  agent?: string;
  endpoint?: string;
  "online-eval"?: string;
  "start-time"?: string;
  "end-time"?: string;
  "session-ids"?: string[];
};

// Kept local for now; extract to a shared util when on-demand evaluate reuses it.
function resolveDataSource(
  flags: SourceFlags,
  rawDataSourceConfig: DataSourceConfig | undefined,
): SessionSourceValue {
  const hasAgent = flags["agent"] !== undefined;
  const hasOnlineEval = flags["online-eval"] !== undefined;
  const hasRaw = rawDataSourceConfig !== undefined;

  const armCount = [hasAgent, hasOnlineEval, hasRaw].filter(Boolean).length;
  if (armCount !== 1) {
    throw new InputValidationError(
      "specify exactly one source: '--agent', '--online-eval', or '--data-source-config'",
    );
  }

  const hasIds = !!flags["session-ids"]?.length;

  if (hasRaw) {
    // The raw config is self-contained; the ergonomic filter flags don't apply.
    if (
      flags["start-time"] !== undefined ||
      flags["end-time"] !== undefined ||
      hasIds ||
      flags["endpoint"] !== undefined
    ) {
      throw new InputValidationError(
        "filter flags cannot be combined with '--data-source-config' (put them in the JSON)",
      );
    }
    return { origin: "raw", dataSourceConfig: rawDataSourceConfig! };
  }

  const window = resolveWindow(flags);

  if (hasOnlineEval) {
    // The online-eval arm has no sessionIds filter and no endpoint.
    if (hasIds)
      throw new InputValidationError("'--session-ids' cannot be used with '--online-eval'");
    if (flags["endpoint"])
      throw new InputValidationError("'--endpoint' can only be used with '--agent'");
    return { origin: "online-eval", onlineEvaluationConfigId: flags["online-eval"]!, window };
  }

  return {
    origin: "agent",
    agent: flags["agent"]!,
    endpoint: flags["endpoint"],
    window,
    sessionIds: hasIds ? flags["session-ids"] : undefined,
  };
}

// resolveWindow validates the explicit time window: both halves must come
// together and start must precede end.
function resolveWindow(flags: SourceFlags): SessionWindow | undefined {
  const hasStart = flags["start-time"] !== undefined;
  const hasEnd = flags["end-time"] !== undefined;
  if (!hasStart && !hasEnd) return undefined; // no time filter — all available sessions
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
