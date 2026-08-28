import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import { type EnvVar, BuildTypeSchema } from "../../../../projectSchemas/runtime";
import { RuntimeAuthorizerTypeSchema } from "../../../../projectSchemas/auth";
import { NetworkModeSchema, ProtocolModeSchema } from "../../../../projectSchemas/constants";
import { SourceResolver } from "../../../../io";
import {
  LANGUAGE_VERSION_DEFAULTS,
  MEMORY_SHORTCUT_NAMES,
  MEMORY_SHORTCUTS,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  resolveRuntimeTemplateShortcut,
} from "../../shortcuts";
import { ScaffoldRuntimeInputSchema, type ScaffoldRuntimeInput } from "../../types";
import { RuntimeResourceConfigSchema, type ImportBedrockAgentInput } from "./types";
import { describeBedrockAgent } from "../../../../core/project/bedrockAgent";
import {
  importScaffoldRuntimeInput,
  resolveImportBedrockAgentInput,
} from "../../importBedrockAgent";
import { RegionKey } from "../../../keys";

export const createAddRuntimeHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime",
    description: "adds a runtime to the current project",
    flags: [
      flag("name", "the name of the runtime", z.string().max(42).optional()),
      flag("description", "an optional description of the runtime", z.string().optional()),
      flag(
        "type",
        "create scaffolds new agent code (the default); import wraps an existing Bedrock Agent",
        z.enum(["create", "import"]).optional(),
      ),
      flag(
        "agent-id",
        "Bedrock Agent ID to import (requires --type import)",
        z.string().optional(),
      ),
      flag(
        "agent-alias-id",
        "Bedrock Agent Alias ID to import (requires --type import)",
        z.string().optional(),
      ),
      flag(
        "template",
        "a preset of flags for scaffolding the runtime; compatible flags override preset values",
        z.enum(RUNTIME_TEMPLATE_SHORTCUT_NAMES).optional(),
      ),
      flag("build", "build type: CodeZip or Container", BuildTypeSchema.optional()),
      flag(
        "language",
        "target language for the scaffolded runtime code",
        z.enum(["Python", "TypeScript"]).optional(),
      ),
      flag(
        "framework",
        "agent framework for the scaffolded runtime code",
        z.enum(["strands", "none"]).optional(),
      ),
      flag(
        "model-provider",
        "model provider for the scaffolded runtime code",
        z.enum(["Bedrock"]).optional(),
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "memory",
        "memory option for the scaffolded runtime",
        z.enum(MEMORY_SHORTCUT_NAMES).optional(),
      ),
      flag(
        "role-arn",
        "IAM role ARN that provides permissions for the runtime",
        z.string().optional(),
      ),
      flag(
        "additional-policies",
        "additional IAM policy ARNs or policy document paths for the execution role",
        z.array(z.string()).optional(),
      ),
      flag("protocol", "server protocol: HTTP, MCP, A2A, AGUI", ProtocolModeSchema.optional()),
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
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      const scaffoldingFlags = [
        "build",
        "language",
        "framework",
        "model-provider",
        "api-key",
        "memory",
      ] as const;
      const presentScaffoldingFlags = scaffoldingFlags.filter((f) => flags[f] !== undefined);
      const isTemplate = flags["template"] !== undefined;
      const lockedFlag = (["language", "framework"] as const).find(
        (flagName) => flags[flagName] !== undefined,
      );
      if (isTemplate && lockedFlag) {
        throw new InputValidationError(`--${lockedFlag} cannot override a template`);
      }

      const isImport = flags["type"] === "import";
      if (isImport && (isTemplate || presentScaffoldingFlags.length > 0)) {
        const offending = isTemplate ? "template" : presentScaffoldingFlags[0];
        throw new InputValidationError(
          `--type import wraps an existing Bedrock Agent; --${offending} is a scaffolding ` +
            `flag and cannot be combined with it`,
        );
      }
      if (!isImport && (flags["agent-id"] !== undefined || flags["agent-alias-id"] !== undefined)) {
        throw new InputValidationError("--agent-id and --agent-alias-id require --type import");
      }

      const isCustom = presentScaffoldingFlags.length > 0;

      const source = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await source.resolveSecret("api-key", flags["api-key"]);

      const runtimeName = flags.name;

      let importBedrockAgent: ImportBedrockAgentInput | undefined;
      if (isImport) {
        const { imported, warnings } = await resolveImportBedrockAgentInput({
          describeBedrockAgent: config.describeBedrockAgent ?? describeBedrockAgent,
          region: ctx.require(RegionKey),
          agentId: flags["agent-id"],
          agentAliasId: flags["agent-alias-id"],
        });
        importBedrockAgent = imported;
        for (const warning of warnings) config.io.stderr.write(`${warning}\n`);
      }

      const defaultMemory = flags.framework === "strands" ? "longAndShortTerm" : "none";
      const scaffoldRuntimeInput: ScaffoldRuntimeInput = isImport
        ? importScaffoldRuntimeInput(runtimeName)
        : isTemplate
          ? resolveRuntimeTemplateShortcut(flags.template!, {
              runtimeName: flags.name,
              build: flags.build,
              modelProvider: flags["model-provider"],
              apiKey,
              memory: flags.memory,
            })
          : isCustom
            ? parseScaffoldRuntimeInput({
                runtimeName,
                build: flags.build,
                language: flags.language,
                framework: flags.framework,
                modelProvider: flags["model-provider"],
                apiKey,
                memory: MEMORY_SHORTCUTS[flags.memory ?? defaultMemory](runtimeName),
                runtimeVersion:
                  flags.build === "CodeZip"
                    ? LANGUAGE_VERSION_DEFAULTS[flags.language ?? "Python"]
                    : undefined,
              })
            : resolveRuntimeTemplateShortcut("hello-world-python", { runtimeName: flags.name });

      const inputEnvironmentVariables = parseJsonFlag<Record<string, string>>(
        "environment-variables",
        flags["environment-variables"],
      );

      const runtimeInput = {
        name: flags.name,
        description: flags.description,
        executionRoleArn: flags["role-arn"],
        additionalPolicies: flags["additional-policies"],
        envVars: toEnvironmentVariables(inputEnvironmentVariables),
        networkMode: flags["network-mode"],
        networkConfig: parseJsonFlag("network-config", flags["network-config"]),
        authorizerType: flags["authorizer-type"],
        authorizerConfiguration: parseJsonFlag(
          "authorizer-configuration",
          flags["authorizer-configuration"],
        ),
        protocol: flags["protocol"],
        requestHeaderAllowlist: flags["request-header-allowlist"],
        lifecycleConfiguration: parseJsonFlag(
          "lifecycle-configuration",
          flags["lifecycle-configuration"],
        ),
        filesystemConfigurations: parseJsonFlag(
          "filesystem-configurations",
          flags["filesystem-configurations"],
        ),
        tags: parseTags(flags["tags"]),
        scaffoldRuntimeInput,
        importBedrockAgent,
      };

      const result = RuntimeResourceConfigSchema.safeParse(runtimeInput);
      if (!result.success)
        throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "runtime",
        resourceConfig: result.data,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added runtime '${flags.name}' to '${project.name}'\n`);
    },
  });

function toEnvironmentVariables(envVars: Record<string, string> | undefined): EnvVar[] {
  return envVars ? Object.entries(envVars).map(([name, value]) => ({ name, value })) : [];
}

function parseScaffoldRuntimeInput(input: Partial<ScaffoldRuntimeInput>) {
  const result = ScaffoldRuntimeInputSchema.safeParse(input);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}
