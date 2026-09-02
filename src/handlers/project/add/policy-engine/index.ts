import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { PolicyEngineSchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseTags } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

/**
 The deployed service name of a policy engine; mirrors the L3 AgentCorePolicyEngine construct's rule.
**/
export function policyEngineResourceName(projectName: string, engineName: string): string {
  return `${projectName}_${engineName}`;
}

export const createAddPolicyEngineHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy-engine",
    description: "adds a Policy Engine to the current project",
    flags: [
      flag("name", "the Policy Engine name", z.string().optional()),
      flag("description", "Policy Engine description", z.string().optional()),
      flag("encryption-key-arn", "KMS encryption key ARN", z.string().optional()),
      flag("tags", "tags as repeated key=value or a JSON object", z.array(z.string()).optional()),
      flag(
        "attach-to-gateways",
        "names of project Gateways to attach this engine to",
        z.array(z.string()).optional(),
      ),
      flag(
        "attach-mode",
        "attached Gateway enforcement mode: log-only or enforce (default enforce)",
        z.enum(["log-only", "enforce"]).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (flags["attach-mode"] !== undefined && flags["attach-to-gateways"] === undefined) {
        throw new InputValidationError("--attach-mode requires --attach-to-gateways");
      }
      const project = ctx.require(ProjectKey);
      const resourceName = policyEngineResourceName(project.name, flags.name);
      if (resourceName.length > 48) {
        throw new InputValidationError(
          `Policy Engine resource name '${resourceName}' exceeds the service limit of 48 characters`,
        );
      }

      const engine: z.input<typeof PolicyEngineSchema> = {
        name: flags.name,
        description: flags.description,
        encryptionKeyArn: flags["encryption-key-arn"],
        tags: parseTags(flags.tags),
      };

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "policy-engine",
        resourceConfig: engine,
        attachGateways: flags["attach-to-gateways"]
          ? {
              names: flags["attach-to-gateways"],
              mode: flags["attach-mode"] === "log-only" ? "LOG_ONLY" : "ENFORCE",
            }
          : undefined,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added Policy Engine '${flags.name}' to '${project.name}'\n`);
      if (flags["attach-to-gateways"]) {
        config.io.stderr.write(
          `attached '${flags.name}' to ${flags["attach-to-gateways"].length} gateway(s)\n`,
        );
      }
    },
  });
