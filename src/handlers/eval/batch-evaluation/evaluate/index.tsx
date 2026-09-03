import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { SessionMetadataShape } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import { SessionSource } from "../../sessionSource";

export const createEvaluateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions service-side (async; returns a job ID)",
    flags: [
      ...SessionSource.flags,
      flag("evaluator", "evaluator ID(s) to apply", z.array(z.string()).optional()),
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

      const source = await SessionSource.resolve(flags, io);

      const resolver = new SourceResolver({ stdin: io.stdin });
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
