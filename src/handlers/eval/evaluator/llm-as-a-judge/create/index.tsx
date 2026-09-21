import z from "zod";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { JsonRendererKey } from "../../../../../tui";
import { SourceResolver, type AppIO } from "../../../../../io";
import { isValidEvaluatorModelId } from "../../../../../projectSchemas/evaluator";
import type { Core } from "../../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../../utils";
import {
  buildEvaluatorModelConfig,
  modelProviderFlag,
  ratingScaleFlag,
  resolveRatingScale,
} from "../sharedFlags";
import { LEVELS } from "../../levels";

export const createLlmAsAJudgeCreateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an LLM-as-a-Judge evaluator",
    flags: [
      flag("name", "the name of the evaluator", z.string().min(1)),
      flag("level", `evaluation level (${LEVELS.join(" | ")})`, z.enum(LEVELS)),
      modelProviderFlag,
      flag(
        "model",
        "judge model: a Bedrock model ID / ARN, or an OpenResponses model ID",
        z.string().min(1),
      ),
      flag(
        "instructions",
        "evaluation instructions (inline, file://<path>, or - for stdin)",
        z.string().min(1),
      ),
      ratingScaleFlag,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag(
        "tags",
        "tags to apply (JSON object of key/value strings; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      // An omitted provider defaults to Bedrock, matching the old CLI.
      const modelProvider = flags["model-provider"] ?? "Bedrock";
      if (!isValidEvaluatorModelId(modelProvider, flags["model"])) {
        throw new InputValidationError(
          modelProvider === "Bedrock"
            ? `invalid --model "${flags["model"]}": expected a Bedrock model ID or an inference-profile/foundation-model ARN`
            : `invalid --model "${flags["model"]}": expected an OpenResponses model ID`,
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const instructions = await source.resolveText("instructions", flags["instructions"]);
      if (instructions.length === 0) {
        throw new InputValidationError("Option '--instructions' must resolve to non-empty text");
      }
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);
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
              modelConfig: buildEvaluatorModelConfig(modelProvider, flags["model"]),
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
