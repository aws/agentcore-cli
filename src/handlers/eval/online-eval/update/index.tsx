import z from "zod";
import type { Filter } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";

export const createUpdateOnlineEvalHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update an online evaluation config",
    flags: [
      flag("id", "the ID of the online evaluation config to update", z.string().optional()),
      flag("sampling-rate", "percentage of sessions to sample (0.01-100)", z.number().optional()),
      flag(
        "session-timeout-minutes",
        "minutes of inactivity before a session is considered complete",
        z.number().optional(),
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
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");
      if (flags["endpoint"] && flags["clear-endpoint"] === "true") {
        throw new InputValidationError(
          "'--endpoint' and '--clear-endpoint' are mutually exclusive",
        );
      }

      const response = await core.onlineEval.updateOnlineEvaluationConfig(
        flags["id"],
        {
          samplingRate: flags["sampling-rate"],
          sessionTimeoutMinutes: flags["session-timeout-minutes"],
          filters: parseJsonFlag<Filter[]>("filters", flags["filters"]),
          evaluatorIds: flags["evaluator"],
          endpoint: flags["endpoint"],
          clearEndpoint: flags["clear-endpoint"] === "true",
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
