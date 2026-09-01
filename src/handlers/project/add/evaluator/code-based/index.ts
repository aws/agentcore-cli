import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import {
  EvaluatorSchema,
  EvaluationLevelSchema,
  isValidBedrockModelId,
} from "../../../../../projectSchemas/evaluator";
import { TagsSchema } from "../../../../../projectSchemas/tags";
import {
  EVALUATOR_LIBRARIES,
  type EvaluatorLibrary,
  type ManagedEvaluatorScaffoldInput,
} from "../../../types";
import { parseJsonFlagWithSchema } from "../../../../utils";
import type { AddProjectResourceConfig } from "../../types";

export const createAddCodeBasedEvaluatorHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "code-based",
    description:
      "add a code-based evaluator — a Lambda that scores a session. Pass a 3P metric, an existing Lambda, or neither to scaffold an empty evaluator you fill in",
    flags: [
      flag("name", "the name of the evaluator", z.string().optional()),
      flag("level", "what to score: SESSION, TRACE, or TOOL_CALL", z.string().optional()),
      flag(
        "metric",
        "3P metric to scaffold as <library.Metric>, e.g. deepeval.FaithfulnessMetric or autoevals.Factuality",
        z.string().optional(),
      ),
      flag(
        "model",
        "judge model for the 3P metric, e.g. bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
        z.string().optional(),
      ),
      flag("lambda-arn", "ARN of an existing Lambda that scores a session", z.string().optional()),
      flag(
        "timeout-seconds",
        "Lambda timeout in seconds (1-300)",
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

      const hasMetric = flags["metric"] !== undefined;
      const hasLambda = flags["lambda-arn"] !== undefined;
      if (hasMetric && hasLambda)
        throw new InputValidationError(
          "provide either --metric (managed) or --lambda-arn (external), not both",
        );

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
        if (flags["metric"] || flags["model"] || flags["timeout-seconds"] !== undefined)
          throw new InputValidationError(
            "--metric, --model, and --timeout-seconds are managed-only and not valid with --lambda-arn",
          );
        const parsed = EvaluatorSchema.safeParse({
          ...base,
          config: { codeBased: { external: { lambdaArn: flags["lambda-arn"] } } },
        });
        if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
        for await (const event of config.projectManager.addResource(project, {
          resourceType: "evaluator",
          resourceConfig: parsed.data,
        })) {
          if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
        }
        config.io.stderr.write(`added evaluator '${flags["name"]}' to '${project.name}'\n`);
        return;
      }

      if (flags["model"] && !hasMetric) throw new InputValidationError("--model requires --metric");

      const scaffold: ManagedEvaluatorScaffoldInput = {
        ...base,
        ...(hasMetric && { metric: parseMetric(flags["metric"]!) }),
        ...(flags["model"] !== undefined && { model: resolveBedrockModel(flags["model"]) }),
        ...(flags["timeout-seconds"] !== undefined && { timeoutSeconds: flags["timeout-seconds"] }),
      };

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "evaluator",
        resourceConfig: { name: scaffold.name },
        scaffold,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added evaluator '${flags["name"]}' to '${project.name}'\n`);
      if (!hasMetric)
        config.io.stderr.write(
          `note: this evaluator returns Pass for every session until you implement app/${flags["name"]}/lambda_function.py\n`,
        );
    },
  });

function parseMetric(raw: string): { library: EvaluatorLibrary; metricClass: string } {
  const dot = raw.indexOf(".");
  const library = dot > 0 ? raw.slice(0, dot) : "";
  const metricClass = dot > 0 ? raw.slice(dot + 1) : "";
  if (!(EVALUATOR_LIBRARIES as readonly string[]).includes(library))
    throw new InputValidationError(
      `invalid --metric "${raw}": expected <library.Metric> where library is one of ${EVALUATOR_LIBRARIES.join(", ")} (e.g. deepeval.FaithfulnessMetric)`,
    );
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(metricClass))
    throw new InputValidationError(
      `invalid metric class "${metricClass}" in --metric "${raw}": expected a single class name like FaithfulnessMetric`,
    );
  return { library: library as EvaluatorLibrary, metricClass };
}

function resolveBedrockModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.startsWith("bedrock/") ? model.slice("bedrock/".length) : model;
  if (!isValidBedrockModelId(id))
    throw new InputValidationError(
      `invalid --model "${model}": expected a Bedrock model ID (e.g. anthropic.claude-3-5-sonnet-20240620-v1:0) or an inference-profile/foundation-model ARN, optionally prefixed with "bedrock/"`,
    );
  return id;
}
