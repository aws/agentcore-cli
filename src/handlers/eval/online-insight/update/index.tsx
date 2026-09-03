import z from "zod";
import type { DataSourceConfig, Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";

const BUILTIN_INSIGHT_PREFIX = "Builtin.Insight.";
const ARN_PREFIX = "arn:";

export const createUpdateOnlineInsightHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an online insight config",
    flags: [
      flag("id", "the ID of the online insight config to update", z.string().optional()),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100).optional(),
      ),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete (1-1440)",
        z.number().int().min(1).max(1440).optional(),
      ),
      flag(
        "filters",
        "trace filters (JSON Filter[]; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "insight",
        "insight ID(s) to apply (replaces the existing list): Builtin.Insight.* or ARN",
        z.array(z.string()).optional(),
      ),
      flag(
        "clustering-frequency",
        "insight clustering cadence(s) (replaces the existing set): DAILY, WEEKLY, MONTHLY",
        z.array(z.enum(["DAILY", "WEEKLY", "MONTHLY"])).optional(),
      ),
      flag("agent", "repoint at a different Runtime ID", z.string().optional()),
      flag(
        "endpoint",
        "re-scope monitoring to a different agent endpoint qualifier",
        z.string().optional(),
      ),
      flag(
        "clear-endpoint",
        "reset the endpoint scope to the default qualifier (pass true)",
        z.enum(["true", "false"]).optional(),
      ),
      flag(
        "data-source-config",
        "replace the traces to evaluate (JSON DataSourceConfig; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("role-arn", "replace the IAM role the online insight assumes", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");
      if (flags["endpoint"] && flags["clear-endpoint"] === "true")
        throw new InputValidationError(
          "'--endpoint' and '--clear-endpoint' are mutually exclusive",
        );
      if (flags["data-source-config"] && flags["agent"])
        throw new InputValidationError(
          "'--agent' and '--data-source-config' are mutually exclusive",
        );
      if (flags["data-source-config"] && (flags["endpoint"] || flags["clear-endpoint"] === "true"))
        throw new InputValidationError(
          "'--endpoint' cannot be combined with '--data-source-config'",
        );

      for (const id of flags["insight"] ?? []) {
        if (!id.startsWith(BUILTIN_INSIGHT_PREFIX) && !id.startsWith(ARN_PREFIX))
          throw new InputValidationError(
            `invalid insight "${id}": must be a ${BUILTIN_INSIGHT_PREFIX}* identifier or a full ARN`,
          );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const frequencies = flags["clustering-frequency"];
      const response = await core.eval.updateOnlineInsight(
        flags["id"],
        {
          samplingRate: flags["sampling-rate"],
          sessionTimeoutMinutes: flags["session-timeout-minutes"],
          filters: parseJsonFlag<Filter[]>(
            "filters",
            await source.resolveText("filters", flags["filters"]),
          ),
          insightIds: flags["insight"],
          clusteringConfig: frequencies ? { frequencies } : undefined,
          agent: flags["agent"],
          endpoint: flags["endpoint"],
          clearEndpoint: flags["clear-endpoint"] === "true",
          dataSourceConfig: parseJsonFlag<DataSourceConfig>(
            "data-source-config",
            await source.resolveText("data-source-config", flags["data-source-config"]),
          ),
          evaluationExecutionRoleArn: flags["role-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
