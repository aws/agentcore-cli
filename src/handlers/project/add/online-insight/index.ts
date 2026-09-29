import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { OnlineEvalConfigSchema } from "../../../../projectSchemas/online-eval-config";
import { parseJsonFlag } from "../../../utils";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits } from "../shared";

export const BUILTIN_INSIGHT_PREFIX = "Builtin.Insight.";
const ARN_PREFIX = "arn:";
export const ONLINE_INSIGHT_DEPLOYED_NAME_MAX_LENGTH = 48;

export interface OnlineInsightInput {
  name: string;
  agent?: string;
  endpoint?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
  insights: string[];
  clusteringFrequencies?: Array<"DAILY" | "WEEKLY" | "MONTHLY">;
  samplingRate: number;
  description?: string;
  enableOnCreate?: boolean;
  tags?: Record<string, string>;
}

export function validateInsightIds(insights: readonly string[]): void {
  for (const id of insights) {
    if (!id.startsWith(BUILTIN_INSIGHT_PREFIX) && !id.startsWith(ARN_PREFIX)) {
      throw new InputValidationError(
        `invalid insight "${id}": must be a ${BUILTIN_INSIGHT_PREFIX}* identifier or a full ARN`,
      );
    }
  }
}

export function toAddOnlineInsightInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: OnlineInsightInput,
): AddResourceInput {
  requireDeployedNameFits(
    "Online insight config",
    project.name,
    input.name,
    "_",
    ONLINE_INSIGHT_DEPLOYED_NAME_MAX_LENGTH,
    targets,
  );
  validateInsightIds(input.insights);

  const parsed = OnlineEvalConfigSchema.safeParse({
    name: input.name,
    agent: input.agent,
    endpoint: input.endpoint,
    logGroupNames: input.logGroupNames,
    serviceNames: input.serviceNames,
    insights: input.insights,
    clusteringConfig: input.clusteringFrequencies
      ? { frequencies: input.clusteringFrequencies }
      : undefined,
    samplingRate: input.samplingRate,
    description: input.description,
    enableOnCreate: input.enableOnCreate,
    tags: input.tags,
  });
  if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));

  return {
    resourceType: "online-insight",
    resourceConfig: parsed.data,
  };
}

export const createAddOnlineInsightHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "online-insight",
    description: "add an online insight config to the current project",
    flags: [
      flag("name", "the name of the online insight config", z.string().min(1)),
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
        "insight",
        "insight ID(s) to apply: Builtin.Insight.* identifiers or full ARNs",
        z.array(z.string()).min(1),
      ),
      flag(
        "clustering-frequency",
        "insight clustering cadence(s): DAILY, WEEKLY, MONTHLY",
        z.array(z.enum(["DAILY", "WEEKLY", "MONTHLY"])).optional(),
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
        "enable insights immediately after deploy (default true; pass false to add it paused)",
        z.enum(["true", "false"]).optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const input = toAddOnlineInsightInput(
        project,
        await config.projectManager.listTargets(project),
        {
          name: flags["name"],
          agent: flags["agent"],
          endpoint: flags["endpoint"],
          logGroupNames: flags["log-group-name"],
          serviceNames: flags["service-name"],
          insights: flags["insight"],
          clusteringFrequencies: flags["clustering-frequency"],
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
        `added online-insight config '${flags["name"]}' to '${project.name}'`,
      );
    },
  });
