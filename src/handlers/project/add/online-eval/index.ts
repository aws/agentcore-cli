import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { OnlineEvalConfigSchema } from "../../../../projectSchemas/online-eval-config";
import { parseJsonFlag } from "../../../utils";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits, cnUnavailable } from "../shared";

export const BUILTIN_EVALUATOR_PREFIX = "Builtin.";
const ARN_PREFIX = "arn:";
export const ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH = 48;

export interface OnlineEvalInput {
  name: string;
  agent?: string;
  endpoint?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
  evaluators?: string[];
  samplingRate: number;
  description?: string;
  enableOnCreate?: boolean;
  tags?: Record<string, string>;
}

export function validateEvaluatorReferences(project: Project, evaluators: readonly string[]): void {
  const projectEvaluators = new Set(project.spec.evaluators.map((evaluator) => evaluator.name));
  for (const evaluator of evaluators) {
    if (
      !evaluator.startsWith(BUILTIN_EVALUATOR_PREFIX) &&
      !evaluator.startsWith(ARN_PREFIX) &&
      !projectEvaluators.has(evaluator)
    ) {
      throw new InputValidationError(
        `unknown evaluator "${evaluator}": use a project evaluator name, a ${BUILTIN_EVALUATOR_PREFIX}* identifier, or a full ARN`,
      );
    }
  }
}

export function toAddOnlineEvalInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: OnlineEvalInput,
): AddResourceInput {
  requireDeployedNameFits(
    "Online-eval config",
    project.name,
    input.name,
    "_",
    ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH,
    targets,
  );
  validateEvaluatorReferences(project, input.evaluators ?? []);

  const parsed = OnlineEvalConfigSchema.safeParse({
    name: input.name,
    agent: input.agent,
    endpoint: input.endpoint,
    logGroupNames: input.logGroupNames,
    serviceNames: input.serviceNames,
    evaluators: input.evaluators,
    samplingRate: input.samplingRate,
    description: input.description,
    enableOnCreate: input.enableOnCreate,
    tags: input.tags,
  });
  if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));

  return {
    resourceType: "online-eval",
    resourceConfig: parsed.data,
  };
}

export const createAddOnlineEvalHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "online-eval",
    description: cnUnavailable("add an online evaluation config to the current project"),
    flags: [
      flag("name", "the name of the online evaluation config", z.string().min(1)),
      flag(
        "agent",
        "Runtime name whose traffic to sample (mutually exclusive with --log-group-name)",
        z.string().optional(),
      ),
      flag(
        "endpoint",
        "the agent endpoint qualifier to scope monitoring to (requires --agent)",
        z.string().optional(),
      ),
      flag(
        "log-group-name",
        "CloudWatch log group name(s) for custom data sources (1-5; mutually exclusive with --agent)",
        z.array(z.string()).optional(),
      ),
      flag(
        "service-name",
        "service name(s) to filter traces for custom data sources (requires --log-group-name)",
        z.array(z.string()).optional(),
      ),
      flag(
        "evaluators",
        "evaluator name(s), Builtin.* IDs, or ARNs to apply",
        z.array(z.string()).optional(),
      ),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100),
      ),
      flag(
        "description",
        "a description of the config's monitoring purpose",
        z.string().optional(),
      ),
      flag(
        "enable-on-create",
        "enable evaluation immediately after deploy (default true; pass false to add it paused)",
        z.enum(["true", "false"]).optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const input = toAddOnlineEvalInput(
        project,
        await config.projectManager.listTargets(project),
        {
          name: flags["name"],
          agent: flags["agent"],
          endpoint: flags["endpoint"],
          logGroupNames: flags["log-group-name"],
          serviceNames: flags["service-name"],
          evaluators: flags["evaluators"],
          samplingRate: flags["sampling-rate"],
          description: flags["description"],
          enableOnCreate:
            flags["enable-on-create"] === undefined
              ? undefined
              : flags["enable-on-create"] === "true",
          tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
        },
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added online-eval config '${flags["name"]}' to '${project.name}'`,
      );
    },
  });
