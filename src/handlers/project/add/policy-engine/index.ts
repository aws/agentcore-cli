import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { PolicyEngineMode } from "../../../../projectSchemas/gateway";
import type { PolicyEngineSchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseTags } from "../../../utils";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";

/** The service limit on a Policy Engine's deployed name. */
export const MAX_POLICY_ENGINE_RESOURCE_NAME_LENGTH = 48;

/**
 The deployed service name of a policy engine; mirrors the L3 AgentCorePolicyEngine construct's rule.
**/
export function policyEngineResourceName(projectName: string, engineName: string): string {
  return `${projectName}_${engineName}`;
}

/**
 * PolicyEngineInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before an engine is built. `attachToGateways`
 * absent means attach to nothing; `attachMode` is only read alongside it.
 */
export interface PolicyEngineInput {
  name: string;
  description?: string;
  encryptionKeyArn?: string;
  tags?: Record<string, string>;
  attachToGateways?: string[];
  attachMode?: PolicyEngineMode;
}

/**
 * toAddPolicyEngineInput is the one place a Policy Engine is assembled from
 * user input: the name limit, the attach default. Both the flag handler and the
 * wizard call it, so they cannot disagree about what an engine is.
 */
export function toAddPolicyEngineInput(
  project: Project,
  input: PolicyEngineInput,
): AddResourceInput {
  const resourceName = policyEngineResourceName(project.name, input.name);
  if (resourceName.length > MAX_POLICY_ENGINE_RESOURCE_NAME_LENGTH) {
    throw new InputValidationError(
      `Policy Engine resource name '${resourceName}' exceeds the service limit of ` +
        `${MAX_POLICY_ENGINE_RESOURCE_NAME_LENGTH} characters`,
    );
  }

  const engine: z.input<typeof PolicyEngineSchema> = {
    name: input.name,
    description: input.description,
    encryptionKeyArn: input.encryptionKeyArn,
    tags: input.tags,
  };
  return {
    resourceType: "policy-engine",
    resourceConfig: engine,
    attachGateways:
      input.attachToGateways && input.attachToGateways.length > 0
        ? { names: input.attachToGateways, mode: input.attachMode ?? "ENFORCE" }
        : undefined,
  };
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
    // handle only turns flags into a PolicyEngineInput — splitting tags,
    // pairing flags that only make sense together. What an engine is belongs
    // to toAddPolicyEngineInput.
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (flags["attach-mode"] !== undefined && flags["attach-to-gateways"] === undefined) {
        throw new InputValidationError("--attach-mode requires --attach-to-gateways");
      }

      const project = ctx.require(ProjectKey);
      const input = toAddPolicyEngineInput(project, {
        name: flags.name,
        description: flags.description,
        encryptionKeyArn: flags["encryption-key-arn"],
        tags: parseTags(flags.tags),
        attachToGateways: flags["attach-to-gateways"],
        attachMode:
          flags["attach-mode"] === undefined
            ? undefined
            : flags["attach-mode"] === "log-only"
              ? "LOG_ONLY"
              : "ENFORCE",
      });

      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added Policy Engine '${flags.name}' to '${project.name}'\n`);
      if (flags["attach-to-gateways"]) {
        config.io.stderr.write(
          `attached '${flags.name}' to ${flags["attach-to-gateways"].length} gateway(s)\n`,
        );
      }
    },
  });
