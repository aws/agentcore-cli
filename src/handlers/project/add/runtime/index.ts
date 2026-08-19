import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import {
  type EnvVar,
  type FilesystemConfiguration,
  type LifecycleConfiguration,
  type NetworkConfig,
  BuildTypeSchema,
} from "../../../../projectSchemas/runtime";
import {
  RuntimeAuthorizerTypeSchema,
  type AuthorizerConfig,
} from "../../../../projectSchemas/auth";
import {
  NetworkModeSchema,
  ProtocolModeSchema,
  RuntimeVersionSchema,
} from "../../../../projectSchemas/constants";
import {
  runtimeModelProviderSchema,
  RUNTIME_TEMPLATES,
  runtimeMemoryConfigSchema,
} from "../../types";
import { SourceResolver } from "../../../../io";

export const createAddRuntimeHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime",
    description:
      "adds a runtime to the current project either from a template or from existing local code",
    flags: [
      flag("name", "the name of the runtime", z.string().optional()),
      flag("description", "an optional description of the runtime", z.string().optional()),
      flag("template", "template to scaffold from", z.enum(RUNTIME_TEMPLATES).optional()),
      flag(
        "role-arn",
        "IAM role ARN that provides permissions for the runtime",
        z.string().optional(),
      ),
      flag("code-location", "path to existing agent source code (BYO path)", z.string().optional()),
      flag("build", "build type: CodeZip or Container", BuildTypeSchema.optional()),
      flag("entrypoint", "entrypoint file, e.g. main.py:handler (BYO only)", z.string().optional()),
      flag("protocol", "server protocol: HTTP, MCP, A2A, AGUI", ProtocolModeSchema.optional()),
      flag(
        "api-key",
        "API key source for non-bedrock model providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
      ),
      flag(
        "model-provider",
        "model provider (template only)",
        runtimeModelProviderSchema.optional(),
      ),
      flag(
        "runtime-version",
        "language runtime, e.g. PYTHON_3_13, NODE_22 (BYO CodeZip only)",
        RuntimeVersionSchema.optional(),
      ),
      flag(
        "dockerfile",
        "dockerfile path for the container build (BYO Container only)",
        z.string().optional(),
      ),
      flag(
        "build-context-path",
        "docker build context directory relative to project root (BYO Container only)",
        z.string().optional(),
      ),
      flag(
        "custom-docker-build-args",
        "docker build args as JSON key/value object (BYO Container only)",
        z.string().optional(),
      ),
      flag(
        "additional-policies",
        "additional IAM policy ARNs or policy document paths for the execution role",
        z.array(z.string()).optional(),
      ),
      flag(
        "network-mode",
        "network mode for the runtime environment (PUBLIC or VPC)",
        NetworkModeSchema.optional(),
      ),
      flag("network-config", "VPC network configuration (JSON)", z.string().optional()),
      flag(
        "authorizer-type",
        "inbound authorizer type (AWS_IAM or CUSTOM_JWT)",
        RuntimeAuthorizerTypeSchema.optional(),
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON)",
        z.string().optional(),
      ),
      flag(
        "request-header-allowlist",
        "request headers to pass through to the runtime",
        z.array(z.string()).optional(),
      ),
      flag("lifecycle-configuration", "lifecycle configuration (JSON)", z.string().optional()),
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
      ),
      flag(
        "filesystem-configurations",
        "filesystem mount configurations (JSON)",
        z.string().optional(),
      ),
      flag(
        "memory",
        "memory configuration (JSON with mode: disabled | create | existing) (template only)",
        z.string().optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      if (flags.template && flags["code-location"])
        throw new InputValidationError("--template and --code-location are mutually exclusive");

      const isTemplate = !flags["code-location"];
      const template = flags.template ?? RUNTIME_TEMPLATES.HELLO_WORLD_PYTHON;
      const templateOnlyFlags = (["memory", "model-provider", "api-key"] as const).filter(
        (f) => flags[f],
      );
      const byoOnlyFlags = (
        [
          "entrypoint",
          "runtime-version",
          "dockerfile",
          "build-context-path",
          "custom-docker-build-args",
        ] as const
      ).filter((f) => flags[f]);

      if (isTemplate && byoOnlyFlags.length > 0)
        throw new InputValidationError(
          `--${byoOnlyFlags[0]} is only available on the BYO path (--code-location)`,
        );
      if (!isTemplate && templateOnlyFlags.length > 0)
        throw new InputValidationError(
          `--${templateOnlyFlags[0]} is only available on the template path (--template)`,
        );

      const inputEnvironmentVariables = parseJsonFlag<Record<string, string>>(
        "environment-variables",
        flags["environment-variables"],
      );
      const memoryConfiguration = parseMemoryConfig(flags["memory"]);

      const entrypoint = flags.entrypoint ?? "main.py";

      const source = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await source.resolveText("api-key", flags["api-key"]);

      if (flags["custom-docker-build-args"] && !flags.dockerfile && !flags["build-context-path"])
        throw new InputValidationError(
          "--custom-docker-build-args requires --dockerfile or --build-context-path",
        );

      const infraConfig = {
        name: flags.name,
        description: flags.description,
        executionRoleArn: flags["role-arn"],
        additionalPolicies: flags["additional-policies"],
        envVars: toEnvironmentVariables(inputEnvironmentVariables),
        networkMode: flags["network-mode"],
        networkConfig: parseJsonFlag<NetworkConfig>("network-config", flags["network-config"]),
        authorizerType: flags["authorizer-type"],
        authorizerConfiguration: parseJsonFlag<AuthorizerConfig>(
          "authorizer-configuration",
          flags["authorizer-configuration"],
        ),
        protocol: flags["protocol"],
        requestHeaderAllowlist: flags["request-header-allowlist"],
        lifecycleConfiguration: parseJsonFlag<LifecycleConfiguration>(
          "lifecycle-configuration",
          flags["lifecycle-configuration"],
        ),
        filesystemConfigurations: parseJsonFlag<FilesystemConfiguration[]>(
          "filesystem-configurations",
          flags["filesystem-configurations"],
        ),
        tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
      };

      const runtimeConfig = isTemplate
        ? {
            source: "template" as const,
            template,
            memory: memoryConfiguration,
            modelProvider: { apiKey, provider: flags["model-provider"] },
            ...infraConfig,
          }
        : {
            source: "byo" as const,
            codeLocation: flags["code-location"]!,
            build: flags.build,
            entrypoint,
            runtimeVersion: flags["runtime-version"],
            dockerfile: flags.dockerfile,
            buildContextPath: flags["build-context-path"],
            customDockerBuildArgs: parseJsonFlag<Record<string, string>>(
              "custom-docker-build-args",
              flags["custom-docker-build-args"],
            ),
            ...infraConfig,
          };

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "runtime",
        resourceConfig: runtimeConfig,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added runtime '${flags.name}' to '${project.name}'\n`);
    },
  });

function parseMemoryConfig(
  raw: string | undefined,
): z.infer<typeof runtimeMemoryConfigSchema> | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonFlag<Record<string, unknown>>("memory", raw);
  const result = runtimeMemoryConfigSchema.safeParse(parsed);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}

function toEnvironmentVariables(envVars: Record<string, string> | undefined): EnvVar[] {
  return envVars ? Object.entries(envVars).map(([name, value]) => ({ name, value })) : [];
}
