import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, requireDeployedNameFits, addDescription } from "../shared";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  DEFAULT_HARNESS_MODEL,
  HarnessSpecSchema,
  type HarnessModelProvider,
} from "../../../../projectSchemas/harness";
import {
  HARNESS_API_KEY_PROVIDER_LABELS,
  harnessApiKeyCredentialName,
} from "../../../../core/project/templates/harness";
import { SourceResolver } from "../../../../io";
import type { AddResourceInput, Project } from "../../types";

const CONFIGURATION = "Configuration:";
const TOOLS_AND_SKILLS = "Tools and skills:";
const MEMORY_AND_CONTEXT = "Memory and context:";
const INVOCATION_LIMITS = "Invocation limits:";
const ENVIRONMENT = "Environment:";
const FILESYSTEM_STORAGE = "Filesystem storage:";
const ACCESS_AND_PERMISSIONS = "Access and permissions:";

// toAddHarnessInput validates what either entry point collected — the flags,
// or the wizard's answers — against the one spec schema, then checks the
// deployed name the way every add does. Both paths therefore refuse the same
// input with the same message.
//
// apiKey is the model's managed API key, already read from its source: the
// model then names the project credential the manager stores it under, so it
// cannot also carry its own apiKeyArn or apiKeyCredentialName.
export function toAddHarnessInput(
  project: Project,
  targets: readonly AwsDeploymentTarget[],
  input: unknown,
  apiKey?: string,
): AddResourceInput {
  const result = HarnessSpecSchema.safeParse(
    apiKey === undefined ? input : withManagedApiKeyCredential(input),
  );
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  requireDeployedNameFits("Harness", project.name, result.data.name, "_", 40, targets);
  return {
    resourceType: "harness",
    resourceConfig: result.data,
    ...(apiKey !== undefined && { apiKey }),
  };
}

function withManagedApiKeyCredential(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const { name, model } = input as { name?: unknown; model?: unknown };
  if (typeof model !== "object" || model === null) return input;
  const { provider, apiKeyArn, apiKeyCredentialName } = model as Record<string, unknown>;
  if (apiKeyArn !== undefined || apiKeyCredentialName !== undefined) {
    throw new InputValidationError(
      "--api-key cannot be combined with apiKeyArn or apiKeyCredentialName in --model",
    );
  }
  if (provider === "bedrock") {
    throw new InputValidationError(
      "--api-key is not supported for the bedrock model provider; Bedrock uses the harness role",
    );
  }
  if (typeof name !== "string" || !isKeyedProvider(provider)) return input;
  return {
    ...input,
    model: { ...model, apiKeyCredentialName: harnessApiKeyCredentialName(name, provider) },
  };
}

function isKeyedProvider(provider: unknown): provider is Exclude<HarnessModelProvider, "bedrock"> {
  return typeof provider === "string" && provider in HARNESS_API_KEY_PROVIDER_LABELS;
}

export const createAddHarnessHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description: addDescription("harness", "add a harness to the current project"),
    flags: [
      flag("name", "the name of the harness", z.string().optional(), { group: CONFIGURATION }),
      flag("model", "model configuration (JSON)", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag(
        "api-key",
        "API key for a non-Bedrock --model; '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { group: CONFIGURATION, sensitive: true },
      ),
      flag("system-prompt", "the agent's system prompt", z.string().optional(), {
        group: CONFIGURATION,
      }),
      flag(
        "tags",
        "tags as key=value (repeatable) or JSON object",
        z.array(z.string()).optional(),
        {
          group: CONFIGURATION,
        },
      ),
      flag("tools", "tools available to the agent (JSON)", z.string().optional(), {
        group: TOOLS_AND_SKILLS,
      }),
      flag(
        "allowed-tools",
        "tool allowlist patterns (e.g. * or @serverName/toolName)",
        z.array(z.string()).optional(),
        { group: TOOLS_AND_SKILLS },
      ),
      flag("skills", "skills available to the agent (JSON)", z.string().optional(), {
        group: TOOLS_AND_SKILLS,
      }),
      flag("memory", "memory configuration (JSON)", z.string().optional(), {
        group: MEMORY_AND_CONTEXT,
      }),
      flag("truncation", "context truncation configuration (JSON)", z.string().optional(), {
        group: MEMORY_AND_CONTEXT,
      }),
      flag("max-iterations", "max agent loop iterations per invocation", z.number().optional(), {
        group: INVOCATION_LIMITS,
      }),
      flag("max-tokens", "max total output tokens per invocation", z.number().optional(), {
        group: INVOCATION_LIMITS,
      }),
      flag("timeout-seconds", "max duration in seconds per invocation", z.number().optional(), {
        group: INVOCATION_LIMITS,
      }),
      flag(
        "container-uri",
        "ECR container image URI; alternative to --dockerfile",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "dockerfile",
        "path to local Dockerfile to build the harness image; alternative to --container-uri",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "network-mode",
        "network mode for the harness environment (PUBLIC or VPC)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag("network-config", "VPC network configuration (JSON)", z.string().optional(), {
        group: ENVIRONMENT,
      }),
      flag(
        "lifecycle-config",
        "session idle timeout and instance lifetime configuration (JSON)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag("session-storage-path", "mount path for session storage", z.string().optional(), {
        group: FILESYSTEM_STORAGE,
      }),
      flag(
        "efs-access-points",
        "EFS access point configurations (JSON; requires VPC)",
        z.string().optional(),
        { group: FILESYSTEM_STORAGE },
      ),
      flag(
        "s3-access-points",
        "S3 access point configurations (JSON; requires VPC)",
        z.string().optional(),
        { group: FILESYSTEM_STORAGE },
      ),
      flag(
        "execution-role-arn",
        "IAM role the harness assumes; a default role is created when omitted",
        z.string().optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "authorizer-type",
        "inbound authorizer type (AWS_IAM or CUSTOM_JWT)",
        z.string().optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON)",
        z.string().optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
    ],
    handle: async (ctx, flags) => {
      const harnessInput = {
        name: flags.name,
        model: parseJsonFlag("model", flags["model"]) ?? DEFAULT_HARNESS_MODEL,
        systemPrompt: flags["system-prompt"],
        executionRoleArn: flags["execution-role-arn"],
        tools: parseJsonFlag("tools", flags["tools"]),
        skills: parseJsonFlag("skills", flags["skills"]),
        allowedTools: flags["allowed-tools"],
        memory: parseJsonFlag("memory", flags["memory"]),
        truncation: parseJsonFlag("truncation", flags["truncation"]),
        networkMode: flags["network-mode"],
        networkConfig: parseJsonFlag("network-config", flags["network-config"]),
        lifecycleConfig: parseJsonFlag("lifecycle-config", flags["lifecycle-config"]),
        sessionStoragePath: flags["session-storage-path"],
        efsAccessPoints: parseJsonFlag("efs-access-points", flags["efs-access-points"]),
        s3AccessPoints: parseJsonFlag("s3-access-points", flags["s3-access-points"]),
        environmentVariables: parseJsonFlag(
          "environment-variables",
          flags["environment-variables"],
        ),
        containerUri: flags["container-uri"],
        authorizerType: flags["authorizer-type"],
        authorizerConfiguration: parseJsonFlag(
          "authorizer-configuration",
          flags["authorizer-configuration"],
        ),
        maxIterations: flags["max-iterations"],
        maxTokens: flags["max-tokens"],
        timeoutSeconds: flags["timeout-seconds"],
        tags: parseTags(flags["tags"]),
        dockerfile: flags["dockerfile"],
      };

      const project = ctx.require(ProjectKey);
      const targets = await config.projectManager.listTargets(project);
      // Validate before reading the key, so a refused input never consumes stdin.
      if (flags["api-key"] !== undefined) toAddHarnessInput(project, targets, harnessInput, "");
      const apiKey = await new SourceResolver({ stdin: config.io.stdin }).resolveSecret(
        "api-key",
        flags["api-key"],
      );
      const input = toAddHarnessInput(project, targets, harnessInput, apiKey);
      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added harness '${flags["name"]}' to '${project.name}'`,
      );
    },
  });
