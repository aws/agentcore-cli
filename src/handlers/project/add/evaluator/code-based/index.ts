import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import type { AwsDeploymentTarget } from "../../../../../projectSchemas/aws-targets";
import { EvaluatorSchema, EvaluationLevelSchema } from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import type { AddResourceInput, ManagedEvaluatorScaffoldInput, Project } from "../../../types";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddProjectResourceConfig } from "../../types";
import { addProjectResource, requireDeployedNameFits } from "../../shared";

export const TimeoutSecondsSchema = z.number().int().min(1).max(300);

export type CodeBasedEvaluatorInput = {
  name: string;
  level: string;
  description?: string;
  kmsKeyArn?: string;
  tags?: Record<string, string>;
} & ({ lambdaArn: string } | { lambdaArn?: undefined; timeoutSeconds?: number });

export function toAddCodeBasedEvaluatorInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: CodeBasedEvaluatorInput,
): AddResourceInput {
  requireDeployedNameFits("Evaluator", project.name, input.name, "_", 48, targets);
  const levelParsed = EvaluationLevelSchema.safeParse(input.level);
  if (!levelParsed.success) throw new InputValidationError(z.prettifyError(levelParsed.error));

  const base = {
    name: input.name,
    level: levelParsed.data,
    description: input.description,
    kmsKeyArn: input.kmsKeyArn,
    tags: input.tags,
  };

  if (input.lambdaArn !== undefined) {
    const parsed = EvaluatorSchema.safeParse({
      ...base,
      config: { codeBased: { external: { lambdaArn: input.lambdaArn } } },
    });
    if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
    return { resourceType: "evaluator", resourceConfig: parsed.data };
  }

  const scaffold: ManagedEvaluatorScaffoldInput = {
    ...base,
    ...(input.timeoutSeconds !== undefined && { timeoutSeconds: input.timeoutSeconds }),
  };
  return { resourceType: "evaluator", resourceConfig: { name: scaffold.name }, scaffold };
}

export function scaffoldedEvaluatorNote(name: string): string {
  return `note: this evaluator returns Pass for every session until you implement app/${name}/lambda_function.py`;
}

export const createAddCodeBasedEvaluatorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "code-based",
    description: "add a code-based evaluator to the current project",
    flags: [
      flag("name", "the name of the evaluator", z.string().min(1)),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().min(1)),
      flag("lambda-arn", "ARN of an existing Lambda that scores a session", z.string().optional()),
      flag(
        "timeout-seconds",
        "evaluator timeout in seconds (1-300)",
        TimeoutSecondsSchema.optional(),
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
      const lambdaArn = flags["lambda-arn"];
      if (lambdaArn !== undefined && flags["timeout-seconds"] !== undefined)
        throw new InputValidationError("--timeout-seconds is not valid with --lambda-arn");

      const input = toAddCodeBasedEvaluatorInput(
        project,
        await config.projectManager.listTargets(project),
        {
          name: flags["name"],
          level: flags["level"],
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
          tags: parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema),
          ...(lambdaArn !== undefined
            ? { lambdaArn }
            : { timeoutSeconds: flags["timeout-seconds"] }),
        },
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added evaluator '${flags["name"]}' to '${project.name}'`,
        lambdaArn === undefined ? { notes: [scaffoldedEvaluatorNote(flags["name"])] } : {},
      );
    },
  });
