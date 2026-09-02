import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { OnlineEvalConfigSchema } from "../../../../projectSchemas/online-eval-config";
import { parseJsonFlag } from "../../../utils";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

/**
 * OnlineEvalInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before an online-eval config is built. It is the
 * schema's own shape less the defaults the schema applies; the source rules
 * (agent or log groups, never both; endpoint needs agent) are the schema's too,
 * and toAddOnlineEvalInput reports them in the schema's words.
 */
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

/**
 * toAddOnlineEvalInput is the one place an online-eval config is assembled and
 * checked. Both the flag handler and the wizard call it.
 */
export function toAddOnlineEvalInput(input: OnlineEvalInput): AddResourceInput {
  const parsed = OnlineEvalConfigSchema.safeParse(input);
  if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));
  return { resourceType: "online-eval", resourceConfig: parsed.data };
}

export const createAddOnlineEvalHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "online-eval",
    description: "adds an online evaluation config to the current project",
    flags: [
      flag("name", "the name of the online evaluation config", z.string().optional()),
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
        "evaluator",
        "evaluator name(s), Builtin.* IDs, or ARNs to apply",
        z.array(z.string()).optional(),
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
        "enable evaluation immediately after deploy (default true; pass false to add it paused)",
        z.enum(["true", "false"]).optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    // handle only turns flags into an OnlineEvalInput. What a config is, and
    // which combinations are allowed, belongs to toAddOnlineEvalInput.
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (flags["sampling-rate"] === undefined)
        throw new InputValidationError(
          "required option '--sampling-rate <sampling-rate>' not specified",
        );

      const input = toAddOnlineEvalInput({
        name: flags["name"],
        agent: flags["agent"],
        endpoint: flags["endpoint"],
        logGroupNames: flags["log-group-name"],
        serviceNames: flags["service-name"],
        evaluators: flags["evaluator"],
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

      config.io.stderr.write(`added online-eval config '${flags["name"]}' to '${project.name}'\n`);
    },
  });
