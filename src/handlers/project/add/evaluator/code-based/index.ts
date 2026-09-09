import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { EvaluatorSchema, EvaluationLevelSchema } from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import type { ManagedEvaluatorScaffoldInput } from "../../../types";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddProjectResourceConfig } from "../../types";
import { addProjectResource } from "../../shared";

export const createAddCodeBasedEvaluatorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "code-based",
    description:
      "add a code-based evaluator — scaffold a Python Lambda with custom evaluation logic, or reference an existing Lambda with --lambda-arn",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().optional()),
      flag("lambda-arn", "ARN of an existing Lambda that scores a session", z.string().optional()),
      flag(
        "timeout-seconds",
        "evaluator timeout in seconds (1-300)",
        z.number().int().min(1).max(300).optional(),
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
      const levelParsed = EvaluationLevelSchema.safeParse(flags["level"]);
      if (!levelParsed.success) throw new InputValidationError(z.prettifyError(levelParsed.error));
      const level = levelParsed.data;

      const hasLambda = flags["lambda-arn"] !== undefined;

      const tags = parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema);
      const base = {
        name: flags["name"],
        level,
        description: flags["description"],
        kmsKeyArn: flags["kms-key-arn"],
        tags,
      };
      const project = ctx.require(ProjectKey);

      if (hasLambda) {
        if (flags["timeout-seconds"] !== undefined)
          throw new InputValidationError("--timeout-seconds is not valid with --lambda-arn");
        const parsed = EvaluatorSchema.safeParse({
          ...base,
          config: { codeBased: { external: { lambdaArn: flags["lambda-arn"] } } },
        });
        if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
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
        return;
      }

      const scaffold: ManagedEvaluatorScaffoldInput = {
        ...base,
        ...(flags["timeout-seconds"] !== undefined && { timeoutSeconds: flags["timeout-seconds"] }),
      };

      await addProjectResource(
        ctx,
        config,
        project,
        {
          resourceType: "evaluator",
          resourceConfig: { name: scaffold.name },
          scaffold,
        },
        `added evaluator '${flags["name"]}' to '${project.name}'`,
        {
          notes: [
            `note: this evaluator returns Pass for every session until you implement app/${flags["name"]}/lambda_function.py`,
          ],
        },
      );
    },
  });
