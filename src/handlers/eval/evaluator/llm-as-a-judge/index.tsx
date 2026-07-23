import z from "zod";
import type { RatingScale } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO, Core } from "../../../types";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import {
  RATING_SCALE_PRESET_IDS,
  isRatingScalePreset,
  ratingScaleFromPreset,
} from "../../ratingScale";
import { SourceResolver } from "../../source";

const LEVELS = ["SESSION", "TRACE", "TOOL_CALL"] as const;

// resolveRatingScale turns the single --rating-scale value into a RatingScale, or
// undefined when the flag is omitted. A value matching a known preset id expands
// to that preset; anything else is a source-aware JSON RatingScale (inline,
// file://<path>, or - for stdin). A file literally named after a preset is still
// reachable via file://.
async function resolveRatingScale(
  value: string | undefined,
  source: SourceResolver,
): Promise<RatingScale | undefined> {
  if (value === undefined) return undefined;
  if (isRatingScalePreset(value)) return ratingScaleFromPreset(value);
  const raw = await source.resolve("rating-scale", value);
  return parseJsonFlag<RatingScale>("rating-scale", raw);
}

const ratingScaleFlag = flag(
  "rating-scale",
  `rating scale: a preset (${RATING_SCALE_PRESET_IDS.join(" | ")}) or a custom RatingScale (JSON inline, file://<path>, or - for stdin)`,
  z.string().optional(),
);

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
      ratingScaleFlag,
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
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);
      if (!ratingScale) {
        throw new TypeError("required option '--rating-scale <rating-scale>' not specified");
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
      ratingScaleFlag,
      flag("kms-key-arn", "customer managed KMS key ARN for evaluator data", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new TypeError("required option '--id <id>' not specified");

      const source = new SourceResolver(io);
      const instructions = await source.resolve("instructions", flags["instructions"]);
      const ratingScale = await resolveRatingScale(flags["rating-scale"], source);

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
