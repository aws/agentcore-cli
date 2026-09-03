import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import type { Core } from "../../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../../utils";
import { instructionsFlag, ratingScaleFlag, resolveRatingScale } from "../sharedFlags";
import { LEVELS } from "../../levels";

export const createLlmAsAJudgeCreateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an LLM-as-a-Judge evaluator",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", `evaluation level (${LEVELS.join(" | ")})`, z.enum(LEVELS).optional()),
      flag("model", "the Bedrock model ID used to judge", z.string().optional()),
      instructionsFlag,
      ratingScaleFlag,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag(
        "tags",
        "tags to apply (JSON object of key/value strings; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (!flags["level"])
        throw new InputValidationError("required option '--level <level>' not specified");
      if (!flags["model"])
        throw new InputValidationError("required option '--model <model>' not specified");

      const source = new SourceResolver({ stdin: io.stdin });
      const instructions = await source.resolveText("instructions", flags["instructions"]);
      if (!instructions) {
        throw new InputValidationError(
          "required option '--instructions <instructions>' not specified",
        );
      }
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);
      if (!ratingScale) {
        throw new InputValidationError(
          "required option '--rating-scale <rating-scale>' not specified",
        );
      }
      const tags = parseJsonFlag<Record<string, string>>(
        "tags",
        await source.resolveText("tags", flags["tags"]),
      );

      const response = await core.eval.createEvaluator(
        {
          evaluatorName: flags["name"],
          level: flags["level"],
          evaluatorConfig: {
            llmAsAJudge: {
              instructions,
              ratingScale,
              modelConfig: { bedrockEvaluatorModelConfig: { modelId: flags["model"] } },
            },
          },
          kmsKeyArn: flags["kms-key-arn"],
          tags,
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
