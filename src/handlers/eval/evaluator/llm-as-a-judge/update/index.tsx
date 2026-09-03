import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import { coreOptsFromCtx } from "../../../../utils";
import { instructionsFlag, ratingScaleFlag, resolveRatingScale } from "../sharedFlags";

export const createLlmAsAJudgeUpdateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an LLM-as-a-Judge evaluator",
    flags: [
      flag("id", "the ID of the evaluator to update", z.string().optional()),
      instructionsFlag,
      flag("model", "the Bedrock model ID used to judge", z.string().optional()),
      ratingScaleFlag,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      const source = new SourceResolver({ stdin: io.stdin });
      const instructions = await source.resolveText("instructions", flags["instructions"]);
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);

      const response = await core.eval.updateLlmAsAJudgeEvaluator(
        flags["id"],
        {
          instructions,
          model: flags["model"],
          ratingScale,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
