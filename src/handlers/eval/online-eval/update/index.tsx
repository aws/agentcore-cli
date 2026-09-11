import z from "zod";
import type { DataSourceConfig, Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonKey } from "../../../keys";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { RoleScopeKind } from "../../types";
import { assertMutuallyExclusiveFlags, coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import { filtersHelp } from "../filtersHelp";
import { onlineEvalDataSourceConfigHelp } from "../dataSourceConfigHelp";
import { OnlineEvalOutputConfigFlag } from "../outputConfig";

const SESSION_SOURCE = "Session source:";
const SOURCE_FILTERS = "Source filters:";
const EVALUATION = "Evaluation:";
const EXECUTION = "Execution:";

const MOVED: Record<RoleScopeKind, string> = {
  input: "data source",
  output: "output destination",
  "input-and-output": "data source and output destination",
};

const QUERY_ACTIONS = "logs:StartQuery and logs:GetQueryResults";
const WRITE_ACTIONS = "logs:CreateLogGroup, logs:CreateLogStream and logs:PutLogEvents";
const NEEDED: Record<RoleScopeKind, string> = {
  input: QUERY_ACTIONS,
  output: WRITE_ACTIONS,
  "input-and-output": `${QUERY_ACTIONS}, plus ${WRITE_ACTIONS}`,
};

export const createUpdateOnlineEvalHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an online evaluation config",
    flags: [
      flag("id", "the ID of the online evaluation config to update", z.string().optional(), {
        group: "Target:",
      }),
      flag(
        "description",
        "replace the description of the config's monitoring purpose",
        z.string().optional(),
        { group: "Configuration:" },
      ),
      flag("agent", "repoint at a different harness ID or Runtime ID", z.string().optional(), {
        group: SESSION_SOURCE,
      }),
      flag(
        "data-source-config",
        "replace the traces to sample (JSON DataSourceConfig)",
        z.string().optional(),
        { group: SESSION_SOURCE, help: onlineEvalDataSourceConfigHelp },
      ),
      flag(
        "endpoint",
        "re-scope monitoring to a different agent endpoint qualifier",
        z.string().optional(),
        { group: SOURCE_FILTERS },
      ),
      flag(
        "clear-endpoint",
        "reset the endpoint scope to the default qualifier (pass true)",
        z.enum(["true", "false"]).optional(),
        { group: SOURCE_FILTERS },
      ),
      flag(
        "evaluators",
        "the ID(s) of the evaluators to apply (replaces the existing list)",
        z.array(z.string()).optional(),
        { group: EVALUATION },
      ),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100).optional(),
        { group: EVALUATION },
      ),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete (1-1440)",
        z.number().int().min(1).max(1440).optional(),
        { group: EVALUATION },
      ),
      flag("filters", "replace the trace filters (JSON Filter[])", z.string().optional(), {
        group: EVALUATION,
        help: filtersHelp,
      }),
      ...OnlineEvalOutputConfigFlag.flags,
      flag(
        "role-arn",
        "replace the IAM role the online evaluation assumes",
        z.string().optional(),
        { group: EXECUTION },
      ),
      flag(
        "update-role",
        "whether to re-scope an auto-provisioned execution role when the data source or output destination changes (default true)",
        z.enum(["true", "false"]).optional(),
        { group: EXECUTION },
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");
      if (flags["endpoint"] && flags["clear-endpoint"] === "true") {
        throw new InputValidationError(
          "'--endpoint' and '--clear-endpoint' are mutually exclusive",
        );
      }
      assertMutuallyExclusiveFlags(flags, ["agent", "data-source-config"]);
      if (
        flags["data-source-config"] &&
        (flags["endpoint"] || flags["clear-endpoint"] === "true")
      ) {
        throw new InputValidationError(
          "'--endpoint' cannot be combined with '--data-source-config'",
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const outputConfig = await OnlineEvalOutputConfigFlag.resolve(flags["output-config"], io);
      const { response, roleScopeWarning } = await core.eval.updateOnlineEvaluationConfig(
        flags["id"],
        {
          description: flags["description"],
          outputConfig,
          samplingRate: flags["sampling-rate"],
          sessionTimeoutMinutes: flags["session-timeout-minutes"],
          filters: parseJsonFlag<Filter[]>(
            "filters",
            await source.resolveText("filters", flags["filters"]),
          ),
          evaluatorIds: flags["evaluators"],
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
        const { reason, roleArn, scope, logGroupNames } = roleScopeWarning;
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
            `warning: the ${MOVED[scope]} moved but the execution role was not re-scoped because ${detail}.\n` +
              `  role: ${roleArn}\n` +
              `  ensure it grants ${NEEDED[scope]} on: ${logGroupNames.join(", ")}\n`,
          );
        }
      }
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
