import z from "zod";
import type { DataSourceConfig, Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonKey } from "../../../keys";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";

export const createUpdateOnlineEvalHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an online evaluation config",
    flags: [
      flag("id", "the ID of the online evaluation config to update", z.string().optional()),
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
        "evaluator",
        "the ID(s) of the evaluators to apply (replaces the existing list)",
        z.array(z.string()).optional(),
      ),
      flag("agent", "repoint at a different harness ID or Runtime ID", z.string().optional()),
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
      flag("role-arn", "replace the IAM role the online evaluation assumes", z.string().optional()),
      flag(
        "update-role",
        "whether to re-scope an auto-provisioned execution role when the data source changes (default true)",
        z.enum(["true", "false"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");
      if (flags["endpoint"] && flags["clear-endpoint"] === "true") {
        throw new InputValidationError(
          "'--endpoint' and '--clear-endpoint' are mutually exclusive",
        );
      }
      if (flags["data-source-config"] && flags["agent"]) {
        throw new InputValidationError(
          "'--agent' and '--data-source-config' are mutually exclusive",
        );
      }
      if (
        flags["data-source-config"] &&
        (flags["endpoint"] || flags["clear-endpoint"] === "true")
      ) {
        throw new InputValidationError(
          "'--endpoint' cannot be combined with '--data-source-config'",
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const { response, roleScopeWarning } = await core.eval.updateOnlineEvaluationConfig(
        flags["id"],
        {
          samplingRate: flags["sampling-rate"],
          sessionTimeoutMinutes: flags["session-timeout-minutes"],
          filters: parseJsonFlag<Filter[]>(
            "filters",
            await source.resolveText("filters", flags["filters"]),
          ),
          evaluatorIds: flags["evaluator"],
          agent: flags["agent"],
          endpoint: flags["endpoint"],
          clearEndpoint: flags["clear-endpoint"] === "true",
          dataSourceConfig: parseJsonFlag<DataSourceConfig>(
            "data-source-config",
            await source.resolveText("data-source-config", flags["data-source-config"]),
          ),
          evaluationExecutionRoleArn: flags["role-arn"],
          updateRole:
            flags["update-role"] === undefined ? undefined : flags["update-role"] === "true",
        },
        coreOptsFromCtx(ctx),
      );
      // Suppressed under --json, matching runtime/invoke's advisory summary: a
      // scripted caller gets a machine-readable stdout and nothing else.
      if (roleScopeWarning && !ctx.require(JsonKey)) {
        const { reason, roleArn, logGroupNames } = roleScopeWarning;
        if (reason === "stale-scope") {
          // The update succeeded and the role grants the new data source; the
          // policy for the superseded one just could not be detached.
          io.stderr.write(
            `warning: the execution role still grants access to the previous data source.\n` +
              `  role: ${roleArn}\n` +
              `  detach the inline policy covering: ${logGroupNames.join(", ")}\n`,
          );
        } else {
          const detail =
            reason === "custom-role"
              ? "it is not managed by the CLI"
              : "re-scoping was declined via --update-role false";
          io.stderr.write(
            `warning: the data source moved but the execution role was not re-scoped because ${detail}.\n` +
              `  role: ${roleArn}\n` +
              `  ensure it grants logs:StartQuery and logs:GetQueryResults on: ${logGroupNames.join(", ")}\n`,
          );
        }
      }
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
