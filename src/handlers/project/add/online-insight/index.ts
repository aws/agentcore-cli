import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import {
  OnlineEvalConfigSchema,
  type ClusteringConfig,
} from "../../../../projectSchemas/online-eval-config";
import { parseJsonFlag } from "../../../utils";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

export const BUILTIN_INSIGHT_PREFIX = "Builtin.Insight.";
const ARN_PREFIX = "arn:";

export type ClusteringFrequency = ClusteringConfig["frequencies"][number];

/**
 * InsightIdSchema is what one --insight value must look like. Exported so the
 * wizard's insights step refuses the same values the flag path refuses.
 */
export const InsightIdSchema = z
  .string()
  .refine((id) => id.startsWith(BUILTIN_INSIGHT_PREFIX) || id.startsWith(ARN_PREFIX), {
    message: `must be a ${BUILTIN_INSIGHT_PREFIX}* identifier or a full ARN`,
  });

/**
 * OnlineInsightInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before an online-insight config is built. The
 * source rules are the schema's; the insight-ID shape is checked here.
 */
export interface OnlineInsightInput {
  name: string;
  agent?: string;
  endpoint?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
  insights?: string[];
  clusteringFrequencies?: ClusteringFrequency[];
  samplingRate: number;
  description?: string;
  enableOnCreate?: boolean;
  tags?: Record<string, string>;
}

/**
 * toAddOnlineInsightInput is the one place an online-insight config is
 * assembled and checked. Both the flag handler and the wizard call it.
 */
export function toAddOnlineInsightInput(input: OnlineInsightInput): AddResourceInput {
  for (const id of input.insights ?? []) {
    if (!InsightIdSchema.safeParse(id).success)
      throw new InputValidationError(
        `invalid insight "${id}": must be a ${BUILTIN_INSIGHT_PREFIX}* identifier or a full ARN`,
      );
  }

  const { clusteringFrequencies, ...rest } = input;
  const parsed = OnlineEvalConfigSchema.safeParse({
    ...rest,
    clusteringConfig:
      clusteringFrequencies && clusteringFrequencies.length > 0
        ? { frequencies: clusteringFrequencies }
        : undefined,
  });
  if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
  return { resourceType: "online-insight", resourceConfig: parsed.data };
}

export const createAddOnlineInsightHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "online-insight",
    description: "adds an online insight config to the current project",
    flags: [
      flag("name", "the name of the online insight config", z.string().optional()),
      flag(
        "agent",
        "runtime name whose traffic to sample (mutually exclusive with --log-group-name)",
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
        z.array(z.string()).optional(),
      ),
      flag(
        "clustering-frequency",
        "insight clustering cadence(s): DAILY, WEEKLY, MONTHLY",
        z.array(z.enum(["DAILY", "WEEKLY", "MONTHLY"])).optional(),
      ),
      flag(
        "sampling-rate",
        "percentage of sessions to sample (0.01-100)",
        z.number().min(0.01).max(100).optional(),
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
    // handle only turns flags into an OnlineInsightInput. What a config is, and
    // which combinations are allowed, belongs to toAddOnlineInsightInput.
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (flags["sampling-rate"] === undefined)
        throw new InputValidationError(
          "required option '--sampling-rate <sampling-rate>' not specified",
        );

      const input = toAddOnlineInsightInput({
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
      });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(
        `added online-insight config '${flags["name"]}' to '${project.name}'\n`,
      );
    },
  });
