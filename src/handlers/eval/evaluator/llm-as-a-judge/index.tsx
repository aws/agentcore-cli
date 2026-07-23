import z from "zod";
import type { RatingScale } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO, Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import { RATING_SCALE_PRESET_IDS, ratingScaleFromPreset } from "../../ratingScale";
import { SourceResolver } from "../../source";

const LEVELS = ["SESSION", "TRACE", "TOOL_CALL"] as const;

// resolveRatingScale turns the mutually-exclusive --rating-scale / --rating-scale-json
// flags into a RatingScale, or undefined when neither is given. `source` resolves
// the JSON form's inline / file:// / stdin value before parsing.
async function resolveRatingScale(
  preset: string | undefined,
  json: string | undefined,
  source: SourceResolver,
): Promise<RatingScale | undefined> {
  if (preset !== undefined && json !== undefined) {
    throw new TypeError("pass only one of '--rating-scale' or '--rating-scale-json'");
  }
  if (preset !== undefined) {
    return ratingScaleFromPreset(preset as (typeof RATING_SCALE_PRESET_IDS)[number]);
  }
  const raw = await source.resolve("rating-scale-json", json);
  return parseJsonFlag<RatingScale>("rating-scale-json", raw);
}

const ratingScaleFlags = [
  flag(
    "rating-scale",
    `rating scale preset (${RATING_SCALE_PRESET_IDS.join(" | ")})`,
    z.enum(RATING_SCALE_PRESET_IDS).optional(),
  ),
  flag(
    "rating-scale-json",
    "custom rating scale (JSON RatingScale; inline, file://<path>, or - for stdin)",
    z.string().optional(),
  ),
] as const;

const instructionsFlag = flag(
  "instructions",
  "evaluation instructions (inline, file://<path>, or - for stdin)",
  z.string().optional(),
);

export const createLlmAsAJudgeCreateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an LLM-as-a-Judge evaluator",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", `evaluation level (${LEVELS.join(" | ")})`, z.enum(LEVELS).optional()),
      flag("model", "the Bedrock model id used to judge", z.string().optional()),
      instructionsFlag,
      ...ratingScaleFlags,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag(
        "tags",
        "tags to apply (JSON object of key/value strings; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) throw new TypeError("required option '--name <name>' not specified");
      if (!flags["level"]) throw new TypeError("required option '--level <level>' not specified");
      if (!flags["model"]) throw new TypeError("required option '--model <model>' not specified");

      const source = new SourceResolver(io);
      const instructions = await source.resolve("instructions", flags["instructions"]);
      if (!instructions) {
        throw new TypeError("required option '--instructions <instructions>' not specified");
      }
      const ratingScale = await resolveRatingScale(
        flags["rating-scale"],
        flags["rating-scale-json"],
        source,
      );
      if (!ratingScale) {
        throw new TypeError("one of '--rating-scale' or '--rating-scale-json' is required");
      }
      const tags = parseJsonFlag<Record<string, string>>(
        "tags",
        await source.resolve("tags", flags["tags"]),
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
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export const createLlmAsAJudgeUpdateHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an LLM-as-a-Judge evaluator",
    flags: [
      flag("id", "the ID of the evaluator to update", z.string().optional()),
      instructionsFlag,
      flag("model", "the Bedrock model id used to judge", z.string().optional()),
      ...ratingScaleFlags,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new TypeError("required option '--id <id>' not specified");

      const source = new SourceResolver(io);
      const instructions = await source.resolve("instructions", flags["instructions"]);
      const ratingScale = await resolveRatingScale(
        flags["rating-scale"],
        flags["rating-scale-json"],
        source,
      );

      const response = await core.eval.updateLlmAsAJudgeEvaluator(
        flags["id"],
        {
          instructions,
          model: flags["model"],
          ratingScale,
          kmsKeyArn: flags["kms-key-arn"],
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
