import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import { type EnvVar, BuildTypeSchema } from "../../../../projectSchemas/runtime";
import { RuntimeAuthorizerTypeSchema } from "../../../../projectSchemas/auth";
import { NetworkModeSchema } from "../../../../projectSchemas/constants";
import { SourceResolver } from "../../../../io";
import {
  LANGUAGE_VERSION_DEFAULTS,
  MEMORY_SHORTCUT_NAMES,
  MEMORY_SHORTCUTS,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  resolveRuntimeTemplateShortcut,
} from "../../shortcuts";
import {
  ModelProviderSchema,
  ScaffoldRuntimeInputSchema,
  type ScaffoldRuntimeInput,
} from "../../types";
import { RuntimeResourceConfigSchema, type ImportBedrockAgentInput } from "./types";
import {
  importScaffoldRuntimeInput,
  resolveImportBedrockAgentInput,
} from "../../importBedrockAgent";
import { RegionKey } from "../../../keys";

export const createAddRuntimeHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime",
    description: "add a Runtime to the current project",
    flags: [
      flag("name", "the name of the Runtime", z.string().max(42).optional()),
      flag("description", "an optional description of the Runtime", z.string().optional()),
      flag(
        "type",
        "create scaffolds new agent code (the default); import translates a Bedrock Agent version",
        z.enum(["create", "import"]).optional(),
      ),
      flag(
        "agent-id",
        "Bedrock Agent ID to import (requires --type import)",
        z.string().optional(),
      ),
      flag(
        "agent-alias-id",
        "Bedrock Agent Alias ID selecting the version to import; must point at a prepared " +
          "version, not DRAFT (requires --type import)",
        z.string().optional(),
      ),
      flag(
        "template",
        "a preset of flags for scaffolding the Runtime; compatible flags override preset values",
        z.enum(RUNTIME_TEMPLATE_SHORTCUT_NAMES).optional(),
      ),
      flag("build", "build type: CodeZip or Container", BuildTypeSchema.optional()),
      flag(
        "language",
        "target language for the scaffolded Runtime code",
        z.enum(["Python", "TypeScript"]).optional(),
      ),
      flag(
        "framework",
        "agent framework: strands or none for create; strands or langgraph for import",
        z.enum(["strands", "langgraph", "none"]).optional(),
      ),
      flag(
        "model-provider",
        "model provider for the scaffolded Runtime code (Bedrock, Anthropic, OpenAI, or Gemini)",
        ModelProviderSchema.optional(),
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers: '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "memory",
        "memory option for the scaffolded Runtime",
        z.enum(MEMORY_SHORTCUT_NAMES).optional(),
      ),
      flag(
        "role-arn",
        "IAM role ARN that provides permissions for the Runtime",
        z.string().optional(),
      ),
      flag(
        "additional-policies",
        "additional IAM policy ARNs or policy document paths for the execution role",
        z.array(z.string()).optional(),
      ),
      flag(
        "protocol",
        "server protocol: HTTP, MCP, or A2A",
        z.enum(["HTTP", "MCP", "A2A"]).optional(),
      ),
      flag(
        "network-mode",
        "network mode for the Runtime environment (PUBLIC or VPC)",
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
        "request headers to pass through to the Runtime",
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
        "protocol",
        "model-provider",
        "api-key",
        "memory",
      ] as const;
      const presentScaffoldingFlags = scaffoldingFlags.filter((f) => flags[f] !== undefined);
      const isTemplate = flags["template"] !== undefined;
      const lockedFlag = (["language", "framework", "protocol"] as const).find(
        (flagName) => flags[flagName] !== undefined,
      );
      if (isTemplate && lockedFlag) {
        throw new InputValidationError(`--${lockedFlag} cannot override a template`);
      }

      const isImport = flags["type"] === "import";
      const importIncompatibleFlags = (
        ["build", "language", "model-provider", "api-key"] as const
      ).filter((flagName) => flags[flagName] !== undefined);
      if (isImport && (isTemplate || importIncompatibleFlags.length > 0)) {
        const offending = isTemplate ? "template" : importIncompatibleFlags[0];
        throw new InputValidationError(
          `--type import translates a Bedrock Agent into Python CodeZip runtime code; ` +
            `--${offending} cannot be combined with it`,
        );
      }
      if (!isImport && (flags["agent-id"] !== undefined || flags["agent-alias-id"] !== undefined)) {
        throw new InputValidationError("--agent-id and --agent-alias-id require --type import");
      }
      if (isImport && flags.framework === "none") {
        throw new InputValidationError("--type import supports --framework strands or langgraph");
      }
      if (!isImport && flags.framework === "langgraph") {
        throw new InputValidationError("--framework langgraph requires --type import");
      }
      if (isImport && flags.protocol !== undefined && flags.protocol !== "HTTP") {
        throw new InputValidationError("an imported Bedrock Agent only supports HTTP");
      }

      const isCustom = presentScaffoldingFlags.length > 0;

      const source = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await source.resolveSecret("api-key", flags["api-key"]);

      const runtimeName = flags.name;
      const importMemory = flags.memory ?? "none";

      let importBedrockAgent: ImportBedrockAgentInput | undefined;
      if (isImport) {
        importBedrockAgent = await resolveImportBedrockAgentInput({
          importer: config.bedrockAgentImporter,
          runtimeName,
          region: ctx.require(RegionKey),
          agentId: flags["agent-id"],
          agentAliasId: flags["agent-alias-id"],
          framework: flags.framework === "langgraph" ? "langgraph" : "strands",
          memory: importMemory,
        });
        if (importBedrockAgent.notes.length > 0) {
          config.io.stderr.write(
            `Import generated ${importBedrockAgent.notes.length} manual follow-up ` +
              `${importBedrockAgent.notes.length === 1 ? "item" : "items"} in ` +
              `app/${runtimeName}/IMPORT_NOTES.md.\n`,
          );
        }
      }

      const defaultMemory = flags.framework === "strands" ? "longAndShortTerm" : "none";
      const scaffoldRuntimeInput: ScaffoldRuntimeInput = isImport
        ? importScaffoldRuntimeInput(runtimeName, MEMORY_SHORTCUTS[importMemory](runtimeName))
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
                framework: flags.framework === "langgraph" ? undefined : flags.framework,
                protocol: flags.protocol,
                modelProvider: flags["model-provider"],
                apiKey,
                memory: MEMORY_SHORTCUTS[flags.memory ?? defaultMemory](runtimeName),
                runtimeVersion:
                  flags.build === "CodeZip"
                    ? LANGUAGE_VERSION_DEFAULTS[flags.language ?? "Python"]
                    : undefined,
              })
            : resolveRuntimeTemplateShortcut("agent-python", { runtimeName: flags.name });

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
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
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
