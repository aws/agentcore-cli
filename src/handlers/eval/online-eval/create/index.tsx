import z from "zod";
import type { DataSourceConfig, Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import {
  assertMutuallyExclusiveFlags,
  coreOptsFromCtx,
  parseJsonFlag,
  parseJsonFlagWithSchema,
} from "../../../utils";
import { filtersHelp } from "../filtersHelp";
import { onlineEvalDataSourceConfigHelp } from "../dataSourceConfigHelp";
import { OnlineEvalOutputConfigFlag } from "../outputConfig";
import { TagsSchema } from "../../../../projectSchemas/tags";

const tagsHelp = `(JSON: map of string to string)
Tags applied to the online evaluation configuration.

Accepts inline JSON, file://<path>, or - to read stdin.

Example:
  --tags '{"team":"ml-platform","env":"prod"}'`;

const CONFIGURATION = "Configuration:";
const SESSION_SOURCE = "Session source (choose exactly one):";
const EVALUATION = "Evaluation:";

export const createCreateOnlineEvalHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an online evaluation config",
    flags: [
      flag("name", "the name of the online evaluation config", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag(
        "description",
        "a description of the config's monitoring purpose",
        z.string().optional(),
        {
          group: CONFIGURATION,
        },
      ),
      flag(
        "enable-on-create",
        "whether to enable evaluation immediately (default true; pass false to create it paused)",
        z.enum(["true", "false"]).optional(),
        { group: CONFIGURATION },
      ),
      flag("tags", "resource tags (JSON object of key/value strings)", z.string().optional(), {
        group: CONFIGURATION,
        help: tagsHelp,
      }),
      flag("agent", "harness ID or Runtime ID whose traffic to sample", z.string().optional(), {
        group: SESSION_SOURCE,
      }),
      flag(
        "data-source-config",
        "the traces to sample (JSON DataSourceConfig), as an alternative to --agent",
        z.string().optional(),
        { group: SESSION_SOURCE, help: onlineEvalDataSourceConfigHelp },
      ),
      flag(
        "endpoint",
        "the agent endpoint qualifier to scope monitoring to (default DEFAULT)",
        z.string().optional(),
        { group: SESSION_SOURCE },
      ),
      flag("evaluators", "the ID(s) of the evaluators to apply", z.array(z.string()).optional(), {
        group: EVALUATION,
      }),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100).optional(),
        { group: EVALUATION },
      ),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete (1-1440, default 15)",
        z.number().int().min(1).max(1440).optional(),
        { group: EVALUATION },
      ),
      flag("filters", "trace filters (JSON Filter[])", z.string().optional(), {
        group: EVALUATION,
        help: filtersHelp,
      }),
      ...OnlineEvalOutputConfigFlag.flags,
      flag(
        "role-arn",
        "IAM role the online evaluation assumes (default auto-provisioned)",
        z.string().optional(),
        { group: "Execution:" },
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (!flags["sampling-rate"]) {
        throw new InputValidationError(
          "required option '--sampling-rate <sampling-rate>' not specified",
        );
      }
      if (!flags["evaluators"] || flags["evaluators"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluators <evaluators...>' not specified",
        );
      }

      assertMutuallyExclusiveFlags(flags, ["agent", "data-source-config"], { exactlyOne: true });
      const hasAgent = flags["agent"] !== undefined;
      const hasDataSource = flags["data-source-config"] !== undefined;
      if (hasDataSource && flags["endpoint"]) {
        throw new InputValidationError("'--endpoint' can only be used with '--agent'");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const outputConfig = await OnlineEvalOutputConfigFlag.resolve(flags["output-config"], io);
      const tags = parseJsonFlagWithSchema(
        "tags",
        await source.resolveText("tags", flags["tags"]),
        TagsSchema,
      );
      const common = {
        name: flags["name"],
        description: flags["description"],
        tags,
        outputConfig,
        samplingRate: flags["sampling-rate"],
        sessionTimeoutMinutes: flags["session-timeout-minutes"],
        filters: parseJsonFlag<Filter[]>(
          "filters",
          await source.resolveText("filters", flags["filters"]),
        ),
        evaluatorIds: flags["evaluators"],
        evaluationExecutionRoleArn: flags["role-arn"],
        enableOnCreate:
          flags["enable-on-create"] === undefined
            ? undefined
            : flags["enable-on-create"] === "true",
      };

      const response = await core.eval.createOnlineEvaluationConfig(
        hasAgent
          ? { ...common, agent: flags["agent"]!, endpoint: flags["endpoint"] }
          : {
              ...common,
              dataSourceConfig: parseJsonFlag<DataSourceConfig>(
                "data-source-config",
                await source.resolveText("data-source-config", flags["data-source-config"]),
              )!,
            },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
