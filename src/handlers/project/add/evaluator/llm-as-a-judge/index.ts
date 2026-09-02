import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { SourceResolver } from "../../../../../io";
import {
  EvaluatorSchema,
  isValidBedrockModelId,
  RatingScaleSchema,
  type EvaluationLevel,
  type RatingScale,
} from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddResourceInput } from "../../../types";
import type { AddProjectResourceConfig } from "../../types";
import {
  isRatingScalePreset,
  RATING_SCALE_PRESETS,
  RATING_SCALE_PRESET_NAMES,
} from "./ratingScales";

/**
 * JudgeModelSchema is what --model must look like. Exported so the wizard's
 * model step refuses the same values the flag path refuses, with the same words.
 */
export const JudgeModelSchema = z.string().refine(isValidBedrockModelId, {
  message:
    "expected a Bedrock model ID (e.g. anthropic.claude-3-5-sonnet-20240620-v1:0) or an inference-profile/foundation-model ARN",
});

/**
 * LlmAsAJudgeEvaluatorInput is what every entry point — the flag handler, the
 * wizard — resolves its own inputs to before an evaluator is built. The rating
 * scale is already resolved (see resolveRatingScale) and the instructions
 * already read from wherever the user kept them.
 */
export interface LlmAsAJudgeEvaluatorInput {
  name: string;
  level: EvaluationLevel;
  model: string;
  instructions: string;
  ratingScale: RatingScale;
  description?: string;
  kmsKeyArn?: string;
  tags?: Record<string, string>;
}

/**
 * toAddLlmAsAJudgeEvaluatorInput is the one place an LLM-as-a-Judge evaluator
 * is assembled and checked against the project schema. Both the flag handler
 * and the wizard call it.
 */
export function toAddLlmAsAJudgeEvaluatorInput(input: LlmAsAJudgeEvaluatorInput): AddResourceInput {
  const model = JudgeModelSchema.safeParse(input.model);
  if (!model.success)
    throw new InputValidationError(
      `invalid --model "${input.model}": ${model.error.issues[0]?.message}`,
    );

  const parsed = EvaluatorSchema.safeParse({
    name: input.name,
    level: input.level,
    description: input.description,
    config: {
      llmAsAJudge: {
        model: input.model,
        instructions: input.instructions,
        ratingScale: input.ratingScale,
      },
    },
    kmsKeyArn: input.kmsKeyArn,
    tags: input.tags,
  });
  if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
  return { resourceType: "evaluator", resourceConfig: parsed.data };
}

export const createAddLlmAsAJudgeEvaluatorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "llm-as-a-judge",
    description:
      "add an LLM-as-a-Judge evaluator — another LLM prompted with instructions on how to score a session",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().optional()),
      flag(
        "model",
        "Bedrock model ID or inference-profile/foundation-model ARN for the judge",
        z.string().optional(),
      ),
      flag(
        "instructions",
        "scoring instructions for the judge (inline text, 'file://<path>', or '-' for stdin); use level placeholders like '{context}'",
        z.string().optional(),
      ),
      flag(
        "rating-scale",
        `a rating scale preset (${RATING_SCALE_PRESET_NAMES.join(", ")}) or an inline JSON rating scale`,
        z.string().optional(),
      ),
      flag("description", "a description of what this evaluator measures", z.string().optional()),
      flag(
        "kms-key-arn",
        "customer-managed KMS key ARN to encrypt the evaluator",
        z.string().optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    // handle only turns flags into an LlmAsAJudgeEvaluatorInput — reading the
    // instructions from their source, expanding the rating-scale preset. What an
    // evaluator is belongs to toAddLlmAsAJudgeEvaluatorInput.
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (!flags["level"])
        throw new InputValidationError("required option '--level <level>' not specified");
      if (!flags["model"])
        throw new InputValidationError("required option '--model <model>' not specified");
      if (flags["instructions"] === undefined)
        throw new InputValidationError(
          "required option '--instructions <instructions>' not specified",
        );
      if (flags["rating-scale"] === undefined)
        throw new InputValidationError(
          "required option '--rating-scale <rating-scale>' not specified",
        );

      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const instructions = (await resolver.resolveText("instructions", flags["instructions"]))!;

      const input = toAddLlmAsAJudgeEvaluatorInput({
        name: flags["name"],
        // The level's enum is checked by the schema inside the builder, so an
        // unknown level is reported in the schema's words.
        level: flags["level"] as EvaluationLevel,
        model: flags["model"],
        instructions,
        ratingScale: resolveRatingScale(flags["rating-scale"]),
        description: flags["description"],
        kmsKeyArn: flags["kms-key-arn"],
        tags: parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema),
      });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added evaluator '${flags["name"]}' to '${project.name}'\n`);
    },
  });

/**
 * A preset name expands to a fresh copy of the shared table; anything else is
 * treated as an inline JSON rating scale and validated against the schema.
 * Exported so the wizard's custom-scale step resolves exactly as the flag does.
 */
export function resolveRatingScale(value: string): RatingScale {
  if (isRatingScalePreset(value)) {
    return structuredClone(RATING_SCALE_PRESETS[value]) as RatingScale;
  }
  if (!value.trim().startsWith("{")) {
    throw new InputValidationError(
      `invalid --rating-scale "${value}": expected a preset (${RATING_SCALE_PRESET_NAMES.join(", ")}) or an inline JSON rating scale`,
    );
  }
  return parseJsonFlagWithSchema("rating-scale", value, RatingScaleSchema)!;
}
