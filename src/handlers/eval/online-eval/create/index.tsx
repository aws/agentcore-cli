import z from "zod";
import type { Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";

export const createCreateOnlineEvalHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create an online evaluation config",
    flags: [
      flag("name", "the name of the online evaluation config", z.string().optional()),
      // Derives the CloudWatch log group/service name from the agent's default
      // trace path. A harness or runtime that emits traces under a custom
      // OTel service name (rather than AgentCore's default) needs
      // --log-group-name/--service-name instead — verified against production
      // configs, some of which point at custom names the agent itself set.
      flag("agent", "harness ID or runtime ID whose traffic to sample", z.string().optional()),
      flag(
        "endpoint",
        "the agent endpoint qualifier to scope monitoring to (default DEFAULT)",
        z.string().optional(),
      ),
      flag(
        "log-group-name",
        "CloudWatch log group name(s) to monitor, for a data source other than --agent",
        z.array(z.string()).optional(),
      ),
      flag(
        "service-name",
        "service name(s) to filter traces within --log-group-name (required alongside it)",
        z.array(z.string()).optional(),
      ),
      flag("evaluator", "the ID(s) of the evaluators to apply", z.array(z.string()).optional()),
      flag("sampling-rate", "percentage of sessions to sample (0.01-100)", z.number().optional()),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete (default 15)",
        z.number().optional(),
      ),
      flag(
        "filters",
        "trace filters (JSON Filter[]; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "role-arn",
        "IAM role the online evaluation assumes (default: auto-provisioned)",
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
      flag("client-token", "idempotency token", z.string().optional()),
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
      const hasLogGroups = flags["log-group-name"] !== undefined;
      if (hasAgent === hasLogGroups) {
        throw new InputValidationError("specify exactly one of '--agent' or '--log-group-name'");
      }
      if (hasLogGroups && !flags["service-name"]) {
        throw new InputValidationError("'--service-name' is required alongside '--log-group-name'");
      }
      if (hasLogGroups && flags["endpoint"]) {
        throw new InputValidationError("'--endpoint' can only be used with '--agent'");
      }

      const filters = parseJsonFlag<Filter[]>("filters", flags["filters"]);
      const enableOnCreate =
        flags["enable-on-create"] === undefined ? undefined : flags["enable-on-create"] === "true";

      const response = await core.eval.createOnlineEvaluationConfig(
        hasAgent
          ? {
              name: flags["name"],
              agent: flags["agent"]!,
              endpoint: flags["endpoint"],
              description: flags["description"],
              samplingRate: flags["sampling-rate"],
              sessionTimeoutMinutes: flags["session-timeout-minutes"],
              filters,
              evaluatorIds: flags["evaluator"],
              evaluationExecutionRoleArn: flags["role-arn"],
              enableOnCreate,
              clientToken: flags["client-token"],
            }
          : {
              name: flags["name"],
              logGroupNames: flags["log-group-name"]!,
              serviceNames: flags["service-name"]!,
              description: flags["description"],
              samplingRate: flags["sampling-rate"],
              sessionTimeoutMinutes: flags["session-timeout-minutes"],
              filters,
              evaluatorIds: flags["evaluator"],
              evaluationExecutionRoleArn: flags["role-arn"],
              enableOnCreate,
              clientToken: flags["client-token"],
            },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
