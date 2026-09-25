import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import { AgentNameSchema, type EnvVar } from "../../../../projectSchemas/runtime";
import { RuntimeAuthorizerTypeSchema } from "../../../../projectSchemas/auth";
import { NetworkModeSchema } from "../../../../projectSchemas/constants";
import { SourceResolver } from "../../../../io";
import {
  RUNTIME_TEMPLATE_SHORTCUTS,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  formatTemplateParameterHelp,
  getDefaultMemorySpec,
  resolveRuntimeTemplateShortcut,
} from "../../shortcuts";
import { ModelProviderSchema, type AddResourceInput, type ScaffoldRuntimeInput } from "../../types";
import { RuntimeResourceConfigSchema, type ImportBedrockAgentInput } from "./types";
import {
  importScaffoldRuntimeInput,
  resolveImportBedrockAgentInput,
} from "../../importBedrockAgent";
import { RegionKey } from "../../../keys";
import { addProjectResource, requireDeployedNameFits } from "../shared";

const CONFIGURATION = "Configuration:";
const ENVIRONMENT = "Environment:";
const ACCESS_AND_PERMISSIONS = "Access and permissions:";
const BEDROCK_AGENT_IMPORT = "Bedrock Agent import:";

// The infrastructure settings that arrive as JSON documents. They are parsed
// but not yet validated when an entry point assembles a runtime, so they are
// `unknown` until toAddRuntimeInput runs the schema over them.
type JsonRuntimeField =
  | "networkConfig"
  | "authorizerConfiguration"
  | "lifecycleConfiguration"
  | "filesystemConfigurations";

/** A runtime resource as an entry point assembles it, before validation. */
export type RuntimeInput = Omit<z.input<typeof RuntimeResourceConfigSchema>, JsonRuntimeField> &
  Partial<Record<JsonRuntimeField, unknown>>;

/**
 * toAddRuntimeInput is the one place a runtime is validated and wrapped for
 * {@link ProjectManager.addResource}. Both the flag handler and the wizard call
 * it, so neither can accept a runtime the other would reject.
 */
export function toAddRuntimeInput(input: RuntimeInput): AddResourceInput {
  const result = RuntimeResourceConfigSchema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return { resourceType: "runtime", resourceConfig: result.data };
}

export const createAddRuntimeHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime",
    description: "add a Runtime to the current project",
    flags: [
      flag("name", "the name of the Runtime", AgentNameSchema, { group: CONFIGURATION }),
      flag(
        "type",
        "create generates new agent code (the default); import translates a Bedrock Agent version",
        z.enum(["create", "import"]).optional(),
        { group: CONFIGURATION },
      ),
      flag(
        "template",
        "template for the Runtime code (default: agent-python-minimal); available templates listed below",
        z.enum(RUNTIME_TEMPLATE_SHORTCUT_NAMES).optional(),
        { group: CONFIGURATION, help: formatTemplateParameterHelp() },
      ),
      flag(
        "model-provider",
        "model provider for supported templates (Bedrock, Anthropic, OpenAI, or Gemini)",
        ModelProviderSchema.optional(),
        { group: CONFIGURATION },
      ),
      flag(
        "api-key",
        "API key for non-Bedrock providers on supported templates; '-' for stdin, 'file://path' for file",
        z.string().optional(),
        { group: CONFIGURATION, sensitive: true },
      ),
      flag("description", "an optional description of the Runtime", z.string().optional(), {
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
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "network-mode",
        "network mode for the Runtime environment (PUBLIC or VPC)",
        NetworkModeSchema.optional(),
        { group: ENVIRONMENT },
      ),
      flag("network-config", "VPC network configuration (JSON)", z.string().optional(), {
        group: ENVIRONMENT,
      }),
      flag(
        "lifecycle-configuration",
        "session idle timeout and instance lifetime configuration (JSON)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "filesystem-configurations",
        "filesystem mount configurations (JSON)",
        z.string().optional(),
        { group: ENVIRONMENT },
      ),
      flag(
        "role-arn",
        "IAM role ARN that provides permissions for the Runtime",
        z.string().optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "additional-policies",
        "additional IAM policy ARNs or policy document paths for the execution role",
        z.array(z.string()).optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "authorizer-type",
        "inbound authorizer type (AWS_IAM or CUSTOM_JWT)",
        RuntimeAuthorizerTypeSchema.optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON)",
        z.string().optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "request-header-allowlist",
        "request headers to pass through to the Runtime",
        z.array(z.string()).optional(),
        { group: ACCESS_AND_PERMISSIONS },
      ),
      flag(
        "agent-id",
        "Bedrock Agent ID to import (requires --type import)",
        z.string().optional(),
        { group: BEDROCK_AGENT_IMPORT },
      ),
      flag(
        "agent-alias-id",
        "Bedrock Agent Alias ID selecting the version to import; must point at a prepared " +
          "version, not DRAFT (requires --type import)",
        z.string().optional(),
        { group: BEDROCK_AGENT_IMPORT },
      ),
      flag(
        "framework",
        "agent framework for an imported Bedrock Agent: strands or langgraph (requires --type import)",
        z.enum(["strands", "langgraph"]).optional(),
        { group: BEDROCK_AGENT_IMPORT },
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      requireDeployedNameFits(
        "Runtime",
        project.name,
        flags.name,
        "_",
        48,
        await config.projectManager.listTargets(project),
      );

      const isImport = flags["type"] === "import";
      const isTemplate = flags["template"] !== undefined;
      const modelFlagsPresent =
        flags["model-provider"] !== undefined || flags["api-key"] !== undefined;

      if (flags.framework !== undefined && !isImport) {
        throw new InputValidationError("--framework requires --type import");
      }

      if (isImport) {
        const importIncompatibleFlags = (["model-provider", "api-key"] as const).filter(
          (flagName) => flags[flagName] !== undefined,
        );
        if (isTemplate || importIncompatibleFlags.length > 0) {
          const offending = isTemplate ? "template" : importIncompatibleFlags[0];
          throw new InputValidationError(
            `--type import translates a Bedrock Agent into Python CodeZip runtime code; ` +
              `--${offending} cannot be combined with it`,
          );
        }
      }
      if (!isImport && (flags["agent-id"] !== undefined || flags["agent-alias-id"] !== undefined)) {
        throw new InputValidationError("--agent-id and --agent-alias-id require --type import");
      }

      if (!isImport && modelFlagsPresent) {
        if (!isTemplate) {
          throw new InputValidationError(
            "--model-provider and --api-key only apply to templates that support them",
          );
        }
        if (!RUNTIME_TEMPLATE_SHORTCUTS[flags.template!].supportsModelProviderOverride) {
          throw new InputValidationError(
            `--model-provider and --api-key are not valid with the ${flags.template} template`,
          );
        }
      }

      const source = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await source.resolveSecret("api-key", flags["api-key"]);

      const runtimeName = flags.name;
      const notes: string[] = [];

      let importBedrockAgent: ImportBedrockAgentInput | undefined;
      if (isImport) {
        importBedrockAgent = await resolveImportBedrockAgentInput({
          importer: config.bedrockAgentImporter,
          runtimeName,
          region: ctx.require(RegionKey),
          agentId: flags["agent-id"],
          agentAliasId: flags["agent-alias-id"],
          framework: flags.framework === "langgraph" ? "langgraph" : "strands",
          memory: "longAndShortTerm",
        });
        if (importBedrockAgent.notes.length > 0) {
          notes.push(
            `Import generated ${importBedrockAgent.notes.length} manual follow-up ` +
              `${importBedrockAgent.notes.length === 1 ? "item" : "items"} in ` +
              `app/${runtimeName}/IMPORT_NOTES.md.`,
          );
        }
      }

      const scaffoldRuntimeInput: ScaffoldRuntimeInput = isImport
        ? importScaffoldRuntimeInput(runtimeName, getDefaultMemorySpec(runtimeName))
        : isTemplate
          ? resolveRuntimeTemplateShortcut(flags.template!, {
              runtimeName: flags.name,
              modelProvider: flags["model-provider"],
              apiKey,
            })
          : resolveRuntimeTemplateShortcut("agent-python-minimal", { runtimeName: flags.name });

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

      await addProjectResource(
        ctx,
        config,
        project,
        toAddRuntimeInput(runtimeInput),
        `added runtime '${flags.name}' to '${project.name}'`,
        { notes },
      );
    },
  });

function toEnvironmentVariables(envVars: Record<string, string> | undefined): EnvVar[] {
  return envVars ? Object.entries(envVars).map(([name, value]) => ({ name, value })) : [];
}
