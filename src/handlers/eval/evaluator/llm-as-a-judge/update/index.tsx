import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import { coreOptsFromCtx } from "../../../../utils";
import { modelProviderFlag, ratingScaleFlag, resolveRatingScale } from "../sharedFlags";

export const createLlmAsAJudgeUpdateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an LLM-as-a-Judge evaluator",
    flags: [
      flag("id", "the ID of the evaluator to update", z.string().min(1)),
      flag(
        "instructions",
        "evaluation instructions (inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      modelProviderFlag,
      flag(
        "model",
        "judge model: a Bedrock model ID / ARN, or an OpenResponses model ID (required when changing provider)",
        z.string().optional(),
      ),
      ratingScaleFlag.optional(),
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const source = new SourceResolver({ stdin: io.stdin });
      const instructions = await source.resolveText("instructions", flags["instructions"]);
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);

      const response = await core.eval.updateLlmAsAJudgeEvaluator(
        flags["id"],
        {
          instructions,
          model: flags["model"],
          // Undefined when omitted, so the update preserves the evaluator's
          // existing provider (the enum schema already validated any value).
          modelProvider: flags["model-provider"],
          ratingScale,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
