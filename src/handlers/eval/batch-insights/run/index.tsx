import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { SessionSource } from "../../sessionSource";

const DEFAULT_INSIGHT = "Builtin.Insight.FailureAnalysis";

export const createRunBatchInsightsHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "run",
    description: "start an asynchronous batch insights run over existing sessions",
    flags: [
      ...SessionSource.flags,
      flag("insight", "insight id(s) to run", z.array(z.string()).default([DEFAULT_INSIGHT])),
      flag(
        "evaluator",
        "optional evaluator id(s) to run alongside the insights",
        z.array(z.string()).optional(),
      ),
      flag("name", "batch insights name (must be unique in the account)", z.string().optional()),
      flag("description", "optional description", z.string().optional()),
      flag("kms-key-arn", "KMS key to encrypt insights data at rest", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const source = await SessionSource.resolve(flags, io);
      const response = await core.eval.startBatchInsights(
        {
          name: flags["name"],
          description: flags["description"],
          insightIds: flags["insight"],
          evaluatorIds: flags["evaluator"],
          source,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
