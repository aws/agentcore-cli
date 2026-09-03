import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import { HarnessSpecSchema } from "../../../../projectSchemas/harness";

/** The model a harness runs on when none is configured; `project create`'s
 * harness path shares it so the two entry points cannot drift. */
export const DEFAULT_HARNESS_MODEL = {
  provider: "bedrock",
  modelId: "global.anthropic.claude-sonnet-4-6",
} as const;

export const createAddHarnessHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description: "add a harness to the current project",
    flags: [
      flag("name", "the name of the harness", z.string().optional()),
      flag(
        "execution-role-arn",
        "IAM role the harness assumes; a default role is created when omitted",
        z.string().optional(),
      ),
      flag("system-prompt", "the agent's system prompt", z.string().optional()),
      flag("model", "model configuration (JSON)", z.string().optional()),
      flag("tools", "tools available to the agent (JSON)", z.string().optional()),
      flag("skills", "skills available to the agent (JSON)", z.string().optional()),
      flag(
        "allowed-tools",
        "tool allowlist patterns (e.g. * or @serverName/toolName)",
        z.array(z.string()).optional(),
      ),
      flag("memory", "memory configuration (JSON)", z.string().optional()),
      flag("truncation", "context truncation configuration (JSON)", z.string().optional()),
      flag(
        "network-mode",
        "network mode for the harness environment (PUBLIC or VPC)",
        z.string().optional(),
      ),
      flag("network-config", "VPC network configuration (JSON)", z.string().optional()),
      flag("lifecycle-config", "lifecycle configuration (JSON)", z.string().optional()),
      flag("session-storage-path", "mount path for session storage", z.string().optional()),
      flag("efs-access-points", "EFS access point configurations (JSON)", z.string().optional()),
      flag("s3-access-points", "S3 access point configurations (JSON)", z.string().optional()),
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
      ),
      flag("container-uri", "ECR container image URI", z.string().optional()),
      flag(
        "authorizer-type",
        "inbound authorizer type (AWS_IAM or CUSTOM_JWT)",
        z.string().optional(),
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON)",
        z.string().optional(),
      ),
      flag("max-iterations", "max agent loop iterations per invocation", z.number().optional()),
      flag("max-tokens", "max total output tokens per invocation", z.number().optional()),
      flag("timeout-seconds", "max duration in seconds per invocation", z.number().optional()),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
      flag(
        "dockerfile",
        "path to local dockerfile to use as the container image for the harness",
        z.string().optional(),
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

      const result = HarnessSpecSchema.safeParse(harnessInput);
      if (!result.success)
        throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "harness",
        resourceConfig: result.data,
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added harness '${flags["name"]}' to '${project.name}'\n`);
    },
  });
