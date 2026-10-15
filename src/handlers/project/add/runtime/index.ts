import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { isChinaRegion } from "../../../../core/partition";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag, parseTags } from "../../../utils";
import { InputValidationError, RegionUnsupportedFeatureError } from "../../../../errors";
import { AgentNameSchema, type EnvVar } from "../../../../projectSchemas/runtime";
import { RuntimeAuthorizerTypeSchema } from "../../../../projectSchemas/auth";
import {
  NetworkModeSchema,
  ProtocolModeSchema,
  type ProtocolMode,
} from "../../../../projectSchemas/constants";
import { getDefaultMemorySpec } from "../../shortcuts";
import type { AddResourceInput } from "../../types";
import {
  RuntimeDocsConfigSchema,
  RuntimeResourceConfigSchema,
  type ImportBedrockAgentInput,
} from "./types";
import {
  importScaffoldRuntimeInput,
  resolveImportBedrockAgentInput,
} from "../../importBedrockAgent";
import { RegionKey } from "../../../keys";
import { addProjectResource, requireDeployedNameFits, addDescription } from "../shared";

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

type WithJsonFields<T> = Omit<T, JsonRuntimeField> & Partial<Record<JsonRuntimeField, unknown>>;

/** A runtime resource as an entry point assembles it, before validation. */
export type RuntimeInput =
  | WithJsonFields<z.input<typeof RuntimeResourceConfigSchema>>
  | WithJsonFields<z.input<typeof RuntimeDocsConfigSchema>>;

/**
 * toAddRuntimeInput is the one place a runtime is validated and wrapped for
 * {@link ProjectManager.addResource}. Both the flag handler and the wizard call
 * it, so neither can accept a runtime the other would reject. An input with
 * scaffoldRuntimeInput scaffolds code (`--type import`); one with a language
 * only gets docs.
 */
export function toAddRuntimeInput(input: RuntimeInput): AddResourceInput {
  const result =
    "scaffoldRuntimeInput" in input
      ? RuntimeResourceConfigSchema.safeParse(input)
      : RuntimeDocsConfigSchema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return { resourceType: "runtime", resourceConfig: result.data };
}

/** The language a `--language` value names, as the spec and templates spell it. */
export const RUNTIME_LANGUAGES = { python: "Python", typescript: "TypeScript" } as const;
export type RuntimeLanguageFlag = keyof typeof RUNTIME_LANGUAGES;

/** What `add runtime` prints after adding a docs-only runtime. */
export function runtimeDocsAddedMessage(
  name: string,
  language: "Python" | "TypeScript",
  protocol: ProtocolMode,
): string {
  const folder = `app/${name}`;
  return [
    `Added runtime "${name}" (${language}, ${protocol}).`,
    "",
    "Next:",
    `  1. Write your agent in ${folder}/. See ${folder}/README.md for what it needs.`,
    `     Using a coding agent? Point it at ${folder}/AGENTS.md.`,
    "  2. Run it locally:  agentcore dev",
    "  3. Deploy it:       agentcore deploy",
  ].join("\n");
}

export const createAddRuntimeHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "runtime",
    description: addDescription("runtime", "add a Runtime to the current project"),
    flags: [
      flag("name", "the name of the Runtime", AgentNameSchema, { group: CONFIGURATION }),
      flag(
        "type",
        "create sets up app/<name>/ with docs for the code you write (the default); " +
          "import translates a Bedrock Agent version into runtime code",
        z.enum(["create", "import"]).optional(),
        { group: CONFIGURATION },
      ),
      flag(
        "language",
        "language you will write the Runtime in: python or typescript (required with --type create)",
        z.enum(["python", "typescript"]).optional(),
        { group: CONFIGURATION },
      ),
      flag(
        "protocol",
        "protocol the Runtime serves: HTTP (default), MCP, A2A, or AGUI",
        ProtocolModeSchema.optional(),
        { group: CONFIGURATION },
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
      const deploymentTargets = await config.projectManager.listTargets(project);
      requireDeployedNameFits("Runtime", project.name, flags.name, "_", 48, deploymentTargets);

      const isImport = flags["type"] === "import";

      if (flags.framework !== undefined && !isImport) {
        throw new InputValidationError("--framework requires --type import");
      }
      if (!isImport && (flags["agent-id"] !== undefined || flags["agent-alias-id"] !== undefined)) {
        throw new InputValidationError("--agent-id and --agent-alias-id require --type import");
      }
      if (isImport) {
        const offending = (["language", "protocol"] as const).find(
          (flagName) => flags[flagName] !== undefined,
        );
        if (offending !== undefined) {
          throw new InputValidationError(
            `--type import translates a Bedrock Agent into Python HTTP runtime code; ` +
              `--${offending} cannot be combined with it`,
          );
        }
      } else if (flags.language === undefined) {
        throw new InputValidationError(
          "required option '--language <language>' not specified: pass python or typescript",
        );
      }

      const runtimeName = flags.name;
      const notes: string[] = [];

      let importBedrockAgent: ImportBedrockAgentInput | undefined;
      if (isImport) {
        // The import path calls Amazon Bedrock, which is not available in the
        // aws-cn partition — fail before any Bedrock call is made. Check the
        // command's resolved region too: it selects the source agent's region
        // and can be a China region even when no China target is configured.
        if (
          deploymentTargets.some((target) => isChinaRegion(target.region)) ||
          isChinaRegion(ctx.require(RegionKey))
        ) {
          throw new RegionUnsupportedFeatureError(
            "--type import translates a Bedrock Agent, and Amazon Bedrock is not available in " +
              "China regions (cn-north-1, cn-northwest-1).",
          );
        }
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

      const inputEnvironmentVariables = parseJsonFlag<Record<string, string>>(
        "environment-variables",
        flags["environment-variables"],
      );

      const infra = {
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
      };

      if (isImport) {
        await addProjectResource(
          ctx,
          config,
          project,
          toAddRuntimeInput({
            ...infra,
            scaffoldRuntimeInput: importScaffoldRuntimeInput(
              runtimeName,
              getDefaultMemorySpec(runtimeName),
            ),
            importBedrockAgent,
          }),
          `added runtime '${flags.name}' to '${project.name}'`,
          { notes },
        );
        return;
      }

      const language = RUNTIME_LANGUAGES[flags.language!];
      const protocol = flags.protocol ?? "HTTP";
      await addProjectResource(
        ctx,
        config,
        project,
        toAddRuntimeInput({ ...infra, language, protocol }),
        runtimeDocsAddedMessage(flags.name, language, protocol),
      );
    },
  });

function toEnvironmentVariables(envVars: Record<string, string> | undefined): EnvVar[] {
  return envVars ? Object.entries(envVars).map(([name, value]) => ({ name, value })) : [];
}
