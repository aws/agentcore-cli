import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { OnlineEvalConfigSchema } from "../../../../projectSchemas/online-eval-config";
import { parseJsonFlag } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

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
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (flags["sampling-rate"] === undefined)
        throw new InputValidationError(
          "required option '--sampling-rate <sampling-rate>' not specified",
        );

      const candidate = {
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
      };

      const parsed = OnlineEvalConfigSchema.safeParse(candidate);
      if (!parsed.success) throw new InputValidationError(z.prettifyError(parsed.error));

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "online-eval",
        resourceConfig: parsed.data,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added online-eval config '${flags["name"]}' to '${project.name}'\n`);
    },
  });
