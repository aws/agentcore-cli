import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { SourceResolver } from "../../../../../io";
import {
  EvaluatorModelProviderSchema,
  EvaluatorSchema,
  isValidEvaluatorModelId,
  RatingScaleSchema,
  type EvaluatorModelProvider,
  type RatingScale,
} from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import type { AddResourceInput } from "../../../types";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddProjectResourceConfig } from "../../types";
import { addProjectResource, requireDeployedNameFits } from "../../shared";
import {
  expandRatingScalePreset,
  isRatingScalePreset,
  RATING_SCALE_PRESET_NAMES,
} from "./ratingScales";

export const MODEL_ID_FORMATS: Record<EvaluatorModelProvider, string> = {
  Bedrock:
    "a Bedrock model ID (e.g. anthropic.claude-3-5-sonnet-20240620-v1:0) or an inference-profile/foundation-model ARN",
  OpenResponses:
    "an OpenResponses model ID (a non-empty identifier without spaces, e.g. openai.gpt-5.4)",
};

export type LlmAsAJudgeEvaluatorInput = {
  name: string;
  level: string;
  modelProvider: EvaluatorModelProvider;
  model: string;
  instructions: string;
  ratingScale: RatingScale;
  description?: string;
  kmsKeyArn?: string;
  tags?: Record<string, string>;
};

export function toAddLlmAsAJudgeEvaluatorInput(input: LlmAsAJudgeEvaluatorInput): AddResourceInput {
  const parsed = EvaluatorSchema.safeParse({
    name: input.name,
    level: input.level,
    description: input.description,
    config: {
      llmAsAJudge: {
        // Bedrock is the default and stays implicit so existing Bedrock
        // agentcore.json files are unchanged; only OpenResponses is written.
        ...(input.modelProvider === "OpenResponses" ? { modelProvider: input.modelProvider } : {}),
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
    description: "add an LLM-as-a-Judge evaluator to the current project",
    flags: [
      flag("name", "the name of the evaluator", z.string().min(1)),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().min(1)),
      flag(
        "model-provider",
        "model provider for the judge: Bedrock (default) or OpenResponses",
        z.string().optional(),
      ),
      flag(
        "model",
        "judge model: a Bedrock model ID / inference-profile-or-foundation-model ARN, or an OpenResponses model ID",
        z.string().min(1),
      ),
      flag(
        "instructions",
        "scoring instructions for the judge (inline text, 'file://<path>', or '-' for stdin); use level placeholders like '{context}'",
        z.string(),
      ),
      flag(
        "rating-scale",
        `a rating scale preset (${RATING_SCALE_PRESET_NAMES.join(", ")}) or an inline JSON rating scale`,
        z.string(),
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
      const project = ctx.require(ProjectKey);
      requireDeployedNameFits(
        "Evaluator",
        project.name,
        flags["name"],
        "_",
        48,
        await config.projectManager.listTargets(project),
      );
      const modelProvider = resolveModelProvider(flags["model-provider"]);
      validateModel(modelProvider, flags["model"]);
      const ratingScale = resolveRatingScale(flags["rating-scale"]);
      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const instructions = await resolver.resolveText("instructions", flags["instructions"]);

      await addProjectResource(
        ctx,
        config,
        project,
        toAddLlmAsAJudgeEvaluatorInput({
          name: flags["name"],
          level: flags["level"],
          modelProvider,
          model: flags["model"],
          instructions,
          ratingScale,
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
          tags: parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema),
        }),
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
  if (!isValidEvaluatorModelId(provider, model))
    throw new InputValidationError(
      `invalid --model "${model}": expected ${MODEL_ID_FORMATS[provider]}`,
    );
}

// A preset name expands to a fresh copy of the shared table; anything else is
// treated as an inline JSON rating scale and validated against the schema.
function resolveRatingScale(value: string): RatingScale {
  if (isRatingScalePreset(value)) return expandRatingScalePreset(value);
  if (!value.trim().startsWith("{")) {
    throw new InputValidationError(
      `invalid --rating-scale "${value}": expected a preset (${RATING_SCALE_PRESET_NAMES.join(", ")}) or an inline JSON rating scale`,
    );
  }
  return parseJsonFlagWithSchema("rating-scale", value, RatingScaleSchema)!;
}
