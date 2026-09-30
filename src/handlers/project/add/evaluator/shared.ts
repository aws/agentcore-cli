import type z from "zod";
import type { Choice } from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  EvaluationLevelSchema,
  EvaluatorNameSchema,
  type EvaluationLevel,
} from "../../../../projectSchemas/evaluator";
import { requireDeployedNameFits } from "../shared";

export const EVALUATOR_MENU = "/agentcore/add/evaluator";

export const EVALUATOR_NAME_HELP =
  "letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 48 characters";

const LEVEL_DESCRIPTIONS: Record<EvaluationLevel, string> = {
  SESSION: "score a whole conversation",
  TRACE: "score each agent response",
  TOOL_CALL: "score each tool call",
};

export const LEVEL_CHOICES: Choice<EvaluationLevel>[] = EvaluationLevelSchema.options.map(
  (level) => ({ value: level, label: level, description: LEVEL_DESCRIPTIONS[level] }),
);

export function evaluatorNameSchema(
  projectName: string,
  targets: readonly AwsDeploymentTarget[],
): z.ZodType<string> {
  return EvaluatorNameSchema.superRefine((name, ctx) => {
    try {
      requireDeployedNameFits("Evaluator", projectName, name, "_", 48, targets);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
