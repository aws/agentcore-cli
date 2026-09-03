import type { DataSourceConfig } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { InputValidationError } from "../../errors";
import { SourceResolver, type AppIO } from "../../io";
import { flag, type Flag } from "../../router";
import { parseJsonFlag } from "../utils";
import type { SessionSourceValue, SessionWindow } from "./types";

export class SessionSource {
  static readonly flags = [
    flag("agent", "source: harness ID or Runtime ID whose sessions to use", z.string().optional()),
    flag(
      "endpoint",
      "Runtime endpoint qualifier (default DEFAULT; only with --agent)",
      z.string().optional(),
    ),
    flag(
      "online-eval",
      "source: use sessions an online-eval config already sampled",
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
      "filter: specific session IDs (only with --agent)",
      z.array(z.string()).optional(),
    ),
  ] as const;

  static async resolve(flags: SessionSourceFlags, io: AppIO): Promise<SessionSourceValue> {
    const resolver = new SourceResolver({ stdin: io.stdin });
    const rawDataSourceConfig = parseJsonFlag<DataSourceConfig>(
      "data-source-config",
      await resolver.resolveText("data-source-config", flags["data-source-config"]),
    );
    return SessionSource.resolveDataSource(flags, rawDataSourceConfig);
  }

  private static resolveDataSource(
    flags: SessionSourceFlags,
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
      return { origin: "raw", dataSourceConfig: rawDataSourceConfig };
    }

    const window = SessionSource.resolveWindow(flags);

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

  private static resolveWindow(flags: SessionSourceFlags): SessionWindow | undefined {
    const hasStart = flags["start-time"] !== undefined;
    const hasEnd = flags["end-time"] !== undefined;
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
}

export type SessionSourceFlags = {
  [F in (typeof SessionSource.flags)[number] as F["name"]]: F extends Flag<string, infer T>
    ? T
    : never;
};
