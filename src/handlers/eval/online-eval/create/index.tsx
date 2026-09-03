import z from "zod";
import type { DataSourceConfig, Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";

export const createCreateOnlineEvalHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an online evaluation config",
    flags: [
      flag("name", "the name of the online evaluation config", z.string().optional()),
      flag("agent", "harness ID or Runtime ID whose traffic to sample", z.string().optional()),
      flag(
        "endpoint",
        "the agent endpoint qualifier to scope monitoring to (default DEFAULT)",
        z.string().optional(),
      ),
      flag(
        "data-source-config",
        "the traces to evaluate (JSON DataSourceConfig; inline, file://<path>, or - for stdin), as an alternative to --agent",
        z.string().optional(),
      ),
      flag("evaluator", "the ID(s) of the evaluators to apply", z.array(z.string()).optional()),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100).optional(),
      ),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete (1-1440, default 15)",
        z.number().int().min(1).max(1440).optional(),
      ),
      flag(
        "filters",
        "trace filters (JSON Filter[]; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "role-arn",
        "IAM role the online evaluation assumes (default auto-provisioned)",
        z.string().optional(),
      ),
      flag(
        "enable-on-create",
        "whether to enable evaluation immediately (default true; pass false to create it paused)",
        z.enum(["true", "false"]).optional(),
      ),
      flag(
        "description",
        "a description of the config's monitoring purpose",
        z.string().optional(),
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
      if (!flags["evaluator"] || flags["evaluator"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }

      const hasAgent = flags["agent"] !== undefined;
      const hasDataSource = flags["data-source-config"] !== undefined;
      if (hasAgent === hasDataSource) {
        throw new InputValidationError(
          "specify exactly one of '--agent' or '--data-source-config'",
        );
      }
      if (hasDataSource && flags["endpoint"]) {
        throw new InputValidationError("'--endpoint' can only be used with '--agent'");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const common = {
        name: flags["name"],
        description: flags["description"],
        samplingRate: flags["sampling-rate"],
        sessionTimeoutMinutes: flags["session-timeout-minutes"],
        filters: parseJsonFlag<Filter[]>(
          "filters",
          await source.resolveText("filters", flags["filters"]),
        ),
        evaluatorIds: flags["evaluator"],
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
