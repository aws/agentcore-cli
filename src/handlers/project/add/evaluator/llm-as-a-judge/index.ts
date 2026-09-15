import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { SourceResolver } from "../../../../../io";
import {
  EvaluatorModelProviderSchema,
  EvaluatorSchema,
  isValidBedrockModelId,
  isValidOpenResponsesModelId,
  RatingScaleSchema,
  type EvaluatorModelProvider,
  type RatingScale,
} from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddProjectResourceConfig } from "../../types";
import { addProjectResource } from "../../shared";
import {
  isRatingScalePreset,
  RATING_SCALE_PRESETS,
  RATING_SCALE_PRESET_NAMES,
} from "./ratingScales";

export const createAddLlmAsAJudgeEvaluatorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "llm-as-a-judge",
    description:
      "add an LLM-as-a-Judge evaluator — another LLM prompted with instructions on how to score a session",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().optional()),
      flag(
        "model-provider",
        "model provider for the judge: Bedrock (default) or OpenResponses",
        z.string().optional(),
      ),
      flag(
        "model",
        "judge model: a Bedrock model ID / inference-profile-or-foundation-model ARN, or an OpenResponses model ID",
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

      const modelProvider = resolveModelProvider(flags["model-provider"]);
      validateModel(modelProvider, flags["model"]);

      const ratingScale = resolveRatingScale(flags["rating-scale"]);

      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const instructions = await resolver.resolveText("instructions", flags["instructions"]);

      const candidate = {
        name: flags["name"],
        level: flags["level"],
        description: flags["description"],
        config: {
          llmAsAJudge: {
            // Bedrock is the default and stays implicit so existing Bedrock
            // agentcore.json files are unchanged; only OpenResponses is written.
            ...(modelProvider === "OpenResponses" ? { modelProvider } : {}),
            model: flags["model"],
            instructions,
            ratingScale,
          },
        },
        kmsKeyArn: flags["kms-key-arn"],
        tags: parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema),
      };

      const parsed = EvaluatorSchema.safeParse(candidate);
      if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));

      const project = ctx.require(ProjectKey);
      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "evaluator",
          resourceConfig: parsed.data,
        },
        `added evaluator '${flags["name"]}' to '${project.name}'`,
      );
    },
  });

function resolveModelProvider(value: string | undefined): EvaluatorModelProvider {
  if (value === undefined) return "Bedrock";
  const parsed = EvaluatorModelProviderSchema.safeParse(value);
  if (!parsed.success)
    throw new InputValidationError(
      `invalid --model-provider "${value}": expected Bedrock or OpenResponses`,
    );
  return parsed.data;
}

function validateModel(provider: EvaluatorModelProvider, model: string): void {
  if (provider === "Bedrock") {
    if (!isValidBedrockModelId(model))
      throw new InputValidationError(
        `invalid --model "${model}": expected a Bedrock model ID (e.g. anthropic.claude-3-5-sonnet-20240620-v1:0) or an inference-profile/foundation-model ARN`,
      );
    return;
  }
  if (!isValidOpenResponsesModelId(model))
    throw new InputValidationError(
      `invalid --model "${model}": expected an OpenResponses model ID (a non-empty identifier without spaces, e.g. openai.gpt-5.4)`,
    );
}

// A preset name expands to a fresh copy of the shared table; anything else is
// treated as an inline JSON rating scale and validated against the schema.
function resolveRatingScale(value: string): RatingScale {
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
