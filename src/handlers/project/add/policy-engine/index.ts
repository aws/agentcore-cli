import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { PolicyEngineSchema } from "../../../../projectSchemas/policy";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseTags } from "../../../utils";
import type { AddResourceInput, Project } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits, addDescription } from "../shared";

// The deployed name is <project>_<target>_<name>, and the service caps it here.
export const POLICY_ENGINE_DEPLOYED_NAME_MAX = 48;

export type AttachMode = "enforce" | "log-only";

// PolicyEngineInput is the engine as the flags state it: the engine's own
// fields plus, optionally, the project Gateways to attach it to and how.
export type PolicyEngineInput = {
  name: string;
  description?: string;
  encryptionKeyArn?: string;
  tags?: z.input<typeof PolicyEngineSchema>["tags"];
  attachToGateways?: string[];
  attachMode?: AttachMode;
};

// toAddPolicyEngineInput is the one place a Policy Engine is built from user
// input — the flags, or the wizard's answers — so both paths bound the deployed
// name the same way and attach Gateways under the same rule.
export function toAddPolicyEngineInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: PolicyEngineInput,
): AddResourceInput {
  if (input.attachMode !== undefined && input.attachToGateways === undefined) {
    throw new InputValidationError("--attach-mode requires --attach-to-gateways");
  }
  requireDeployedNameFits(
    "Policy Engine",
    project.name,
    input.name,
    "_",
    POLICY_ENGINE_DEPLOYED_NAME_MAX,
    targets,
  );
  const engine: z.input<typeof PolicyEngineSchema> = {
    name: input.name,
    description: input.description,
    encryptionKeyArn: input.encryptionKeyArn,
    tags: input.tags,
  };
  return {
    resourceType: "policy-engine",
    resourceConfig: engine,
    attachGateways: input.attachToGateways
      ? {
          names: input.attachToGateways,
          mode: input.attachMode === "log-only" ? "LOG_ONLY" : "ENFORCE",
        }
      : undefined,
  };
}

export const createAddPolicyEngineHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "policy-engine",
    description: addDescription("policy-engine", "add a Policy Engine to the current project"),
    flags: [
      flag("name", "the Policy Engine name", z.string().min(1)),
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
      const project = ctx.require(ProjectKey);
      const input = toAddPolicyEngineInput(
        project,
        await config.projectManager.listTargets(project),
        {
          name: flags.name,
          description: flags.description,
          encryptionKeyArn: flags["encryption-key-arn"],
          tags: parseTags(flags.tags),
          attachToGateways: flags["attach-to-gateways"],
          attachMode: flags["attach-mode"],
        },
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added Policy Engine '${flags.name}' to '${project.name}'`,
        {
          notes: flags["attach-to-gateways"]
            ? [`attached '${flags.name}' to ${flags["attach-to-gateways"].length} gateway(s)`]
            : [],
        },
      );
    },
  });
