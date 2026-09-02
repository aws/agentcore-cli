import type { z } from "zod";
import type { BuildType, ProjectRuntime } from "../../../projectSchemas/runtime";
import type {
  HarnessMemoryRef,
  HarnessSkill,
  HarnessSkillGitSource,
  HarnessSkillPathSource,
  HarnessSkillS3Source,
  HarnessSkillAwsSkillsSource,
  HarnessSpec,
  HarnessTool,
  HarnessTruncationConfig,
} from "../../../projectSchemas/harness";
import type { ProjectSpecSchema } from "../../../projectSchemas/project";
import { credentialEnvVarName, type Credential } from "../../../projectSchemas/credential";
import type { Memory } from "../../../projectSchemas/memory";
import type { EnvLocalEntry } from "../../../handlers/project/types";
import { InputValidationError } from "../../../errors/errors";
import { toPythonPackageName } from "../fsUtils";

type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

export const EXPORT_NOTES_FILENAME = "EXPORT_NOTES.md";
export const DEFAULT_EXPORT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** A manual follow-up item recorded while mapping, written to EXPORT_NOTES.md. */
export interface ExportNote {
  category: string;
  message: string;
}

/** A single rendered output line + a tone the caller maps to its own styling. */
export interface ExportNoteLine {
  text: string;
  tone: "warn" | "dim";
}

/** Everything the mapper needs; all reads are done by the caller. */
export interface HarnessExportInput {
  harnessName: string;
  targetAgentName: string;
  /** The parsed harness spec (from app/<name>/harness.json or the service). */
  spec: HarnessSpec;
  /** The resolved system prompt text (system-prompt.md > spec.systemPrompt > default). */
  systemPrompt: string;
  /** The current project spec, for memory lookups and credential dedup. */
  projectSpec: ProjectSpec;
  /** Build override from --build; when absent the harness spec decides. */
  build?: BuildType;
  /**
   * Whether the harness directory holds the Dockerfile that `spec.dockerfile`
   * names (local harnesses only; the caller checks the filesystem).
   */
  harnessDockerfileExists?: boolean;
}

/** How the exported agent's Dockerfile is produced (Container builds only). */
export type DockerfilePlan =
  /** Render the stock template Dockerfile (plain --build Container). */
  | { source: "template" }
  /** Write a FROM-<containerUri> stub extending the harness's prebuilt image. */
  | { source: "stub"; containerUri: string }
  /** Copy the harness's own Dockerfile from the harness directory. */
  | { source: "harnessCopy" }
  /** CodeZip — no Dockerfile at all. */
  | { source: "none" };

/** The pure mapping result; the project manager executes it against the filesystem. */
export interface HarnessExportPlan {
  /** Handlebars context for rendering the strands-http-python template. */
  context: Record<string, unknown>;
  /** The runtimes[] entry to append to agentcore.json. */
  runtime: ProjectRuntime;
  /** New credential entries to append (already-present names are pre-filtered). */
  credentials: Credential[];
  /** Secret material for agentcore/.env.local (e.g. remote MCP header values). */
  envEntries: EnvLocalEntry[];
  /** Generated IAM policy documents written into the agent dir, keyed by filename. */
  policyFiles: Record<string, unknown>;
  /** Whether the render includes the memory/ module. */
  hasMemory: boolean;
  /** Whether the render includes hooks/execution_limits.py. */
  hasExecutionLimits: boolean;
  buildType: BuildType;
  dockerfilePlan: DockerfilePlan;
  notes: ExportNote[];
}

// ============================================================================
// Note categories
// ============================================================================

export const ALLOWED_TOOLS_NOTE_CATEGORY = "allowedTools: per-invocation overrides dropped";
export const GATEWAY_TOOL_NOTE_CATEGORY = "Gateway tool not exported — wire up manually";
export const BROWSER_TOOL_NOTE_CATEGORY = "Browser tool not exported — wire up manually";
export const CODE_INTERPRETER_TOOL_NOTE_CATEGORY =
  "Code-interpreter tool not exported — wire up manually";
export const MEMORY_ARN_NOTE_CATEGORY = "External memory reference not exported";
export const MEMORY_MANAGED_NOTE_CATEGORY = "Managed harness memory not exported";
export const MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY = "Memory reference could not be resolved";
export const PATH_SKILLS_NOTE_CATEGORY = "path skills require container filesystem";
export const GIT_SKILLS_CONTAINER_NOTE_CATEGORY = "git skills require git in container image";
export const GIT_SKILLS_AUTH_NOTE_CATEGORY = "git skill credential provider referenced";
export const AWS_SKILLS_NOTE_CATEGORY =
  "AWS skills omitted — not available outside managed harness";
export const MALFORMED_S3_SKILL_NOTE_CATEGORY =
  "S3 skill URI is malformed — no S3 read permission generated";
export const MCP_HEADER_CREDS_NOTE_CATEGORY = "MCP tool header credentials";
export const LITELLM_NO_API_KEY_NOTE_CATEGORY = "LiteLLM model may require an API key";
export const MODEL_API_KEY_NOTE_CATEGORY = "Model API key credential referenced";
export const CONTAINER_URI_NOTE_CATEGORY = "containerUri: verify Python in base image";
export const CUSTOM_DOCKERFILE_NOTE_CATEGORY =
  "Custom harness Dockerfile needs the agent build layer";
export const MISSING_DOCKERFILE_NOTE_CATEGORY = "Dockerfile not found — create it before deploying";

// ============================================================================
// Public entry point
// ============================================================================

export function mapHarnessToExportPlan(input: HarnessExportInput): HarnessExportPlan {
  const { spec, targetAgentName, projectSpec } = input;
  const notes: ExportNote[] = [];
  const credentials: Credential[] = [];
  const envEntries: EnvLocalEntry[] = [];
  const policyFiles: Record<string, unknown> = {};
  const additionalPolicies: string[] = [];

  const buildType = resolveBuildType(spec, input.build);
  if (buildType === "CodeZip" && (spec.containerUri || spec.dockerfile)) {
    const what = spec.containerUri
      ? `containerUri (${spec.containerUri})`
      : `dockerfile (${spec.dockerfile})`;
    throw new InputValidationError(
      `Harness "${spec.name}" uses ${what}, which requires a Container build. ` +
        `Re-export with --build Container.`,
    );
  }

  const allowedToolPatterns = spec.allowedTools ?? ["*"];
  if (!(allowedToolPatterns.length === 1 && allowedToolPatterns[0] === "*")) {
    notes.push({
      category: ALLOWED_TOOLS_NOTE_CATEGORY,
      message:
        "The harness allowedTools filter has been applied statically at code-generation time. " +
        "Tools excluded at export will not be available at runtime, and callers cannot override " +
        "the tool list per invocation (unlike the harness).",
    });
  }

  const model = resolveModel(spec, projectSpec, credentials, notes);
  const memory = resolveMemory(spec, projectSpec, notes);
  const tools = resolveTools(
    spec,
    allowedToolPatterns,
    projectSpec,
    credentials,
    envEntries,
    notes,
  );
  const skills = resolveSkills(spec, buildType, targetAgentName, credentials, notes);
  for (const [file, doc] of Object.entries(skills.policyFiles)) policyFiles[file] = doc;
  if (model.policyFile) policyFiles[model.policyFile.name] = model.policyFile.doc;
  additionalPolicies.push(...Object.keys(policyFiles));

  const hasExecutionLimits =
    spec.maxIterations !== undefined ||
    spec.maxTokens !== undefined ||
    spec.timeoutSeconds !== undefined;

  const dockerfilePlan = resolveDockerfilePlan(
    spec,
    buildType,
    targetAgentName,
    input.harnessDockerfileExists ?? false,
    notes,
  );

  const filesystemConfigurations = buildFilesystemConfigurations(spec);
  const envVars = Object.entries(spec.environmentVariables ?? {}).map(([name, value]) => ({
    name,
    value,
  }));

  const context: Record<string, unknown> = {
    name: toPythonPackageName(targetAgentName),
    isExportHarness: true,
    entrypoint: "main",
    enableOtel: true,
    hasConfigBundle: false,
    hasPayment: false,
    isVpc: spec.networkMode === "VPC",
    protocol: "HTTP",
    // Model
    ...model.context,
    // System prompt (written verbatim into main.py)
    systemPromptText: input.systemPrompt,
    // Memory
    hasMemory: memory.provider !== undefined,
    memoryEnvVarName: memory.provider?.envVarName,
    memoryStrategies: memory.provider?.strategies ?? [],
    actorId: memory.actorId,
    // Gateways are never exported as code (see resolveTools); the template still
    // needs the keys so its conditionals resolve.
    hasGateway: false,
    gatewayProviders: [],
    gatewayAuthTypes: [],
    // Tools. Empty collections become undefined: the template's custom `or`/
    // `some` helpers use JS truthiness, where [] is truthy, unlike `{{#if}}`.
    inlineFunctionTools: undefinedIfEmpty(tools.inlineFunctionTools),
    remoteMcpTools: undefinedIfEmpty(tools.remoteMcpTools),
    hasShell: tools.hasShell,
    hasFileOperations: tools.hasFileOperations,
    hasBrowser: false,
    hasCodeInterpreter: false,
    // Skills
    hasSkillsFetcher: skills.hasSkillsFetcher,
    hasFetchedSkills: skills.hasFetchedSkills,
    pathSkills: skills.pathSkills,
    s3Skills: undefinedIfEmpty(skills.s3Skills),
    gitSkills: undefinedIfEmpty(skills.gitSkills),
    // Execution limits (numbers are schema-validated >= 1, so plain #if works)
    hasExecutionLimits,
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens,
    timeoutSeconds: spec.timeoutSeconds,
    // Conversation truncation
    truncationStrategy:
      spec.truncation?.strategy === "none" ? undefined : spec.truncation?.strategy,
    truncationConfig: resolveTruncationConfig(spec.truncation),
    // Filesystem mounts (informational for the template; tools are harness builtins)
    sessionStorageMountPath: spec.sessionStoragePath,
    efsMounts: (spec.efsAccessPoints ?? []).map(({ mountPath }) => ({ mountPath })),
    s3Mounts: (spec.s3AccessPoints ?? []).map(({ mountPath }) => ({ mountPath })),
    needsOs:
      !!spec.sessionStoragePath ||
      (spec.efsAccessPoints?.length ?? 0) > 0 ||
      (spec.s3AccessPoints?.length ?? 0) > 0,
  };

  const runtime: ProjectRuntime = {
    name: targetAgentName,
    build: buildType,
    entrypoint: "main.py",
    codeLocation: `app/${targetAgentName}` as ProjectRuntime["codeLocation"],
    protocol: "HTTP",
    ...(buildType === "CodeZip" && { runtimeVersion: "PYTHON_3_14" as const }),
    ...(buildType === "Container" && { dockerfile: "Dockerfile" }),
    ...(envVars.length > 0 && { envVars }),
    ...(spec.networkMode && { networkMode: spec.networkMode }),
    ...(spec.networkMode === "VPC" && spec.networkConfig && { networkConfig: spec.networkConfig }),
    ...(spec.authorizerType && { authorizerType: spec.authorizerType }),
    ...(spec.authorizerConfiguration && {
      authorizerConfiguration: spec.authorizerConfiguration,
    }),
    ...(spec.lifecycleConfig && { lifecycleConfiguration: spec.lifecycleConfig }),
    ...(filesystemConfigurations.length > 0 && { filesystemConfigurations }),
    ...(additionalPolicies.length > 0 && { additionalPolicies }),
    ...(spec.connections?.length && { connections: spec.connections }),
    ...(spec.tags && { tags: spec.tags }),
    // NOTE: the harness's executionRoleArn is deliberately NOT carried over. The
    // exported agent is a new runtime that needs its own CDK-managed role so the
    // construct can attach the runtime baseline, additionalPolicies, and grants.
  };

  return {
    context,
    runtime,
    credentials,
    envEntries,
    policyFiles,
    hasMemory: memory.provider !== undefined,
    hasExecutionLimits,
    buildType,
    dockerfilePlan,
    notes,
  };
}

// ============================================================================
// Model
// ============================================================================

interface ModelResolution {
  context: Record<string, unknown>;
  policyFile?: { name: string; doc: unknown };
}

/** A Bedrock model whose apiFormat routes it through the OpenAI-compatible Mantle endpoint. */
function isBedrockMantleModel(spec: HarnessSpec): boolean {
  return (
    spec.model.provider === "bedrock" &&
    (spec.model.apiFormat === "responses" || spec.model.apiFormat === "chat_completions")
  );
}

/**
 * Proprietary OpenAI models (e.g. openai.gpt-5.x) are served on the Bedrock
 * Mantle `/openai/v1` path; open-source ones (openai.gpt-oss-*) use `/v1`.
 */
function isProprietaryOpenAiModel(modelId: string): boolean {
  return modelId.startsWith("openai.") && !modelId.includes("gpt-oss");
}

function resolveModel(
  spec: HarnessSpec,
  projectSpec: ProjectSpec,
  credentials: Credential[],
  notes: ExportNote[],
): ModelResolution {
  const model = spec.model;
  const context: Record<string, unknown> = {
    modelId: model.modelId,
    // Stringified so a legal 0 (temperature/topP) stays truthy for {{#if}}.
    modelMaxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : undefined,
    modelTemperature: model.temperature !== undefined ? String(model.temperature) : undefined,
    modelTopP: model.topP !== undefined ? String(model.topP) : undefined,
    hasIdentity: false,
    identityProviders: [] as { name: string; envVarName: string }[],
  };

  switch (model.provider) {
    case "bedrock": {
      context.modelProvider = "Bedrock";
      if (isBedrockMantleModel(spec)) {
        context.bedrockMantle = true;
        context.mantleApiFormat = model.apiFormat;
        context.mantleProprietary = isProprietaryOpenAiModel(model.modelId);
        // Mantle is invoked via the bedrock-mantle service, not bedrock:InvokeModel,
        // so the runtime role's default Bedrock grant is insufficient.
        return {
          context,
          policyFile: {
            name: "bedrock-mantle-policy.json",
            doc: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "bedrock-mantle:CreateInference",
                  Resource: "arn:aws:bedrock-mantle:*:*:project/default",
                },
                {
                  Effect: "Allow",
                  Action: "bedrock-mantle:CallWithBearerToken",
                  Resource: "*",
                },
              ],
            },
          },
        };
      }
      return { context };
    }
    case "open_ai":
    case "gemini": {
      context.modelProvider = model.provider === "open_ai" ? "OpenAI" : "Gemini";
      // The schema guarantees apiKeyArn for these providers.
      attachIdentityProvider(
        context,
        model.apiKeyArn!,
        model.provider,
        projectSpec,
        credentials,
        notes,
      );
      return { context };
    }
    case "lite_llm": {
      context.modelProvider = "LiteLLM";
      if (model.apiBase) context.litellmApiBase = model.apiBase;
      if (model.additionalParams && Object.keys(model.additionalParams).length > 0) {
        context.litellmAdditionalParams = model.additionalParams;
      }
      if (model.apiKeyArn) {
        attachIdentityProvider(
          context,
          model.apiKeyArn,
          model.provider,
          projectSpec,
          credentials,
          notes,
        );
      } else if (!model.modelId.startsWith("bedrock/")) {
        // A bedrock/... LiteLLM model authenticates via the execution role; any
        // other keyless provider prefix typically fails at first invocation.
        notes.push({
          category: LITELLM_NO_API_KEY_NOTE_CATEGORY,
          message:
            `The LiteLLM model "${model.modelId}" is not a Bedrock-backed (bedrock/...) model, but ` +
            `the harness has no apiKeyArn. The exported agent constructs LiteLLMModel without an ` +
            `API key and will fail at first invocation if the provider requires one. Add an ` +
            `API-key credential to the harness (model apiKeyArn), or use a bedrock/ model id ` +
            `(which authenticates via the execution role).`,
        });
      }
      return { context };
    }
  }
}

/**
 * Wire a non-Bedrock model's API key through AgentCore Identity: derive the
 * credential-provider name from the token-vault ARN, reference it from the
 * generated load.py, and register a credential entry so deploy grants access.
 */
function attachIdentityProvider(
  context: Record<string, unknown>,
  apiKeyArn: string,
  provider: string,
  projectSpec: ProjectSpec,
  credentials: Credential[],
  notes: ExportNote[],
): void {
  // ARN form: arn:aws:bedrock-agentcore:<region>:<acct>:token-vault/<vault>/apikeycredentialprovider/<name>
  const arnNameMatch = /\/apikeycredentialprovider\/([^/]+)$/.exec(apiKeyArn);
  const credentialName = arnNameMatch ? arnNameMatch[1]! : `${projectSpec.name}${provider}ApiKey`;
  const envVarName = credentialEnvVarName(credentialName);

  context.hasIdentity = true;
  context.identityProviders = [{ name: credentialName, envVarName }];

  const exists = projectSpec.credentials.some((c) => c.name === credentialName);
  if (!exists) {
    credentials.push({ authorizerType: "ApiKeyCredentialProvider", name: credentialName });
  }
  notes.push({
    category: MODEL_API_KEY_NOTE_CATEGORY,
    message:
      `The harness model authenticates with the AgentCore Identity API-key provider ` +
      `"${credentialName}" (${apiKeyArn}). A credential entry referencing it was added to ` +
      `agentcore.json so the deployed agent can fetch the key. For local development ` +
      `(\`agentcore project dev\`), add ${envVarName}=<your-key> to agentcore/.env.local.`,
  });
}

// ============================================================================
// Memory
// ============================================================================

interface MemoryResolution {
  provider?: { name: string; envVarName: string; strategies: string[] };
  actorId?: string;
}

function resolveMemory(
  spec: HarnessSpec,
  projectSpec: ProjectSpec,
  notes: ExportNote[],
): MemoryResolution {
  const memory: HarnessMemoryRef | undefined = spec.memory;
  if (!memory || memory.mode === "disabled") return {};

  if (memory.mode === "managed") {
    notes.push({
      category: MEMORY_MANAGED_NOTE_CATEGORY,
      message:
        "The harness used managed memory, which the service provisions and owns. The exported " +
        "agent has no memory wired. Add a project memory (`agentcore project add memory`) and " +
        "re-run the export, or wire memory/session.py to an existing AgentCore Memory by hand.",
    });
    return {};
  }

  // mode === "existing"
  if (memory.name) {
    const entry: Memory | undefined = projectSpec.memories.find((m) => m.name === memory.name);
    if (!entry) {
      notes.push({
        category: MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY,
        message:
          `The harness references the project memory "${memory.name}", but no memory with that ` +
          `name exists in agentcore.json, so the exported agent has no memory wired. Add the ` +
          `memory to the project and re-export, or wire memory/session.py by hand.`,
      });
      return { actorId: memory.actorId };
    }
    return {
      provider: {
        name: entry.name,
        // Must match the env var the CDK injects for project memories.
        envVarName: `MEMORY_${entry.name.toUpperCase()}_ID`,
        strategies: entry.strategies.map(({ type }) => type),
      },
      actorId: memory.actorId,
    };
  }

  if (memory.arn) {
    notes.push({
      category: MEMORY_ARN_NOTE_CATEGORY,
      message:
        `The harness references the external memory ${memory.arn}. The exported agent cannot be ` +
        `wired to it automatically: the runtime role needs memory permissions on that ARN and the ` +
        `memory id must reach the agent as an environment variable. Either add the memory to this ` +
        `project and re-export, or grant access manually and set the env var read by ` +
        `memory/session.py.`,
    });
  }
  return { actorId: memory.actorId };
}

// ============================================================================
// Tools
// ============================================================================

interface ToolsResolution {
  inlineFunctionTools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  remoteMcpTools: {
    name: string;
    url: string;
    headerCredentials?: { headerKey: string; credentialName: string; envVarName: string }[];
  }[];
  hasShell: boolean;
  hasFileOperations: boolean;
}

function resolveTools(
  spec: HarnessSpec,
  allowedPatterns: string[],
  projectSpec: ProjectSpec,
  credentials: Credential[],
  envEntries: EnvLocalEntry[],
  notes: ExportNote[],
): ToolsResolution {
  const result: ToolsResolution = {
    inlineFunctionTools: [],
    remoteMcpTools: [],
    // Builtin tools are always available in the harness runtime; include them
    // unless the allowedTools filter excludes them.
    hasShell: isBuiltinIncluded("shell", allowedPatterns),
    hasFileOperations: isBuiltinIncluded("file_operations", allowedPatterns),
  };

  for (const tool of spec.tools) {
    if (!matchesAllowedTools(tool.name, allowedPatterns)) continue;

    switch (tool.type) {
      case "inline_function": {
        const cfg = configOf(tool, "inlineFunction") as
          { description: string; inputSchema: Record<string, unknown> } | undefined;
        if (cfg) {
          result.inlineFunctionTools.push({
            name: tool.name,
            description: cfg.description,
            inputSchema: cfg.inputSchema,
          });
        }
        break;
      }
      case "remote_mcp": {
        const cfg = configOf(tool, "remoteMcp") as
          { url: string; headers?: Record<string, string> } | undefined;
        if (!cfg) break;
        const headerKeys = Object.keys(cfg.headers ?? {});
        let headerCredentials: ToolsResolution["remoteMcpTools"][number]["headerCredentials"];
        if (headerKeys.length > 0) {
          headerCredentials = [];
          const toolPrefix = tool.name.replace(/[^A-Za-z0-9]/g, "");
          for (const headerKey of headerKeys) {
            const credentialName = `${projectSpec.name}Mcp${toolPrefix}${headerKey.replace(/[^A-Za-z0-9]/g, "")}`;
            const envVarName = credentialEnvVarName(credentialName);
            headerCredentials.push({ headerKey, credentialName, envVarName });
            if (
              !projectSpec.credentials.some((c) => c.name === credentialName) &&
              !credentials.some((c) => c.name === credentialName)
            ) {
              credentials.push({
                authorizerType: "ApiKeyCredentialProvider",
                name: credentialName,
              });
            }
            envEntries.push({
              key: envVarName,
              value: cfg.headers![headerKey] ?? "",
              comment: `"${headerKey}" header for MCP tool "${tool.name}" (exported from harness "${spec.name}")`,
            });
          }
          notes.push({
            category: MCP_HEADER_CREDS_NOTE_CATEGORY,
            message:
              `MCP tool "${tool.name}" sends request headers whose values are managed via ` +
              `AgentCore Identity. Credential entries were added to agentcore.json and the header ` +
              `values written to agentcore/.env.local; they are provisioned on ` +
              `\`agentcore project deploy\`.\n\n` +
              headerCredentials
                .map((h) => `  ${h.credentialName}  (env var: ${h.envVarName})`)
                .join("\n"),
          });
        }
        result.remoteMcpTools.push({ name: tool.name, url: cfg.url, headerCredentials });
        break;
      }
      case "agentcore_gateway": {
        const cfg = configOf(tool, "agentCoreGateway") as { gatewayArn?: string } | undefined;
        notes.push({
          category: GATEWAY_TOOL_NOTE_CATEGORY,
          message:
            `The gateway tool "${tool.name}"${cfg?.gatewayArn ? ` (${cfg.gatewayArn})` : ""} was ` +
            `not exported: gateway URL discovery, outbound auth, and IAM wiring are managed by ` +
            `the harness runtime. To keep these tools, connect an MCP client to the gateway in ` +
            `mcp_client/client.py and grant the runtime role bedrock-agentcore:InvokeGateway on ` +
            `the gateway (or its OAuth token flow) before deploying.`,
        });
        break;
      }
      case "agentcore_browser": {
        notes.push({
          category: BROWSER_TOOL_NOTE_CATEGORY,
          message:
            `The browser tool "${tool.name}" was not exported. Standalone Strands agents drive ` +
            `AgentCore Browser via strands-agents-tools (AgentCoreBrowser), which needs a ` +
            `Container build, the browser identifier, and bedrock-agentcore browser permissions ` +
            `on the runtime role. Add the dependency and tool wiring in main.py manually if you ` +
            `need it.`,
        });
        break;
      }
      case "agentcore_code_interpreter": {
        notes.push({
          category: CODE_INTERPRETER_TOOL_NOTE_CATEGORY,
          message:
            `The code-interpreter tool "${tool.name}" was not exported. Standalone Strands agents ` +
            `use strands-agents-tools (AgentCoreCodeInterpreter), which needs the interpreter ` +
            `identifier and bedrock-agentcore code-interpreter permissions on the runtime role. ` +
            `Add the dependency and tool wiring in main.py manually if you need it.`,
        });
        break;
      }
    }
  }

  return result;
}

function undefinedIfEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function configOf(tool: HarnessTool, key: string): unknown {
  if (!tool.config || !(key in tool.config)) return undefined;
  return (tool.config as Record<string, unknown>)[key];
}

// ============================================================================
// Skills
// ============================================================================

interface SkillsResolution {
  hasSkillsFetcher: boolean;
  hasFetchedSkills: boolean;
  pathSkills: string[];
  s3Skills: string[];
  gitSkills: { url: string; path?: string; credentialArn?: string; username?: string }[];
  policyFiles: Record<string, unknown>;
}

export function isPathSkill(skill: HarnessSkill): skill is HarnessSkillPathSource {
  return "path" in skill && !("gitUrl" in skill);
}

function isS3Skill(skill: HarnessSkill): skill is HarnessSkillS3Source {
  return "s3Uri" in skill;
}

function isGitSkill(skill: HarnessSkill): skill is HarnessSkillGitSource {
  return "gitUrl" in skill;
}

function isAwsSkill(skill: HarnessSkill): skill is HarnessSkillAwsSkillsSource {
  return "awsSkills" in skill;
}

function resolveSkills(
  spec: HarnessSpec,
  buildType: BuildType,
  targetAgentName: string,
  credentials: Credential[],
  notes: ExportNote[],
): SkillsResolution {
  const pathSkills = spec.skills.filter(isPathSkill).map((s) => s.path);
  const s3SkillSources = spec.skills.filter(isS3Skill);
  const gitSkillSources = spec.skills.filter(isGitSkill);
  const awsSkills = spec.skills.filter(isAwsSkill);
  const policyFiles: Record<string, unknown> = {};

  if (pathSkills.length > 0 && buildType === "CodeZip") {
    notes.push({
      category: PATH_SKILLS_NOTE_CATEGORY,
      message:
        `The following skill paths must exist on the container filesystem at runtime: ` +
        `${pathSkills.join(", ")}. For CodeZip builds, path skills are not supported — switch to ` +
        `a Container build and COPY the skill directory into app/${targetAgentName}/, or use ` +
        `s3/git skill variants.`,
    });
  }

  if (gitSkillSources.length > 0 && buildType === "Container") {
    notes.push({
      category: GIT_SKILLS_CONTAINER_NOTE_CATEGORY,
      message:
        "The agent clones git skill repositories at runtime using `git`. The default Container " +
        "base image does not include git. Add it to your Dockerfile before deploying:\n\n" +
        "  RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*",
    });
  }

  // The agent fetches S3 skills with boto3 at runtime, so the runtime execution
  // role needs S3 read access the managed harness never granted.
  if (s3SkillSources.length > 0) {
    const malformedUris: string[] = [];
    const objectResources: string[] = [];
    const bucketResources: string[] = [];
    for (const { s3Uri } of s3SkillSources) {
      const parsed = parseS3SkillArns(s3Uri);
      if (!parsed) {
        malformedUris.push(s3Uri);
        continue;
      }
      if (!objectResources.includes(parsed.objectArn)) objectResources.push(parsed.objectArn);
      if (!bucketResources.includes(parsed.bucketArn)) bucketResources.push(parsed.bucketArn);
    }
    if (malformedUris.length > 0) {
      notes.push({
        category: MALFORMED_S3_SKILL_NOTE_CATEGORY,
        message:
          `These S3 skill URIs could not be parsed into a bucket, so no S3 read permission was ` +
          `generated for them: ${malformedUris.map((u) => `"${u}"`).join(", ")}. The exported ` +
          `agent still attempts to fetch these skills at runtime and will fail with S3 ` +
          `AccessDenied. Fix the s3Uri values (expected \`s3://<bucket>/<prefix>\`) on this ` +
          `agent in agentcore/agentcore.json and re-deploy.`,
      });
    }
    if (objectResources.length > 0) {
      policyFiles["s3-skills-policy.json"] = {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "s3:GetObject", Resource: objectResources },
          { Effect: "Allow", Action: "s3:ListBucket", Resource: bucketResources },
        ],
      };
    }
  }

  // Private git skills reference an API-key credential provider for clone auth.
  // Persist a name-only credential entry per provider so deploy grants access.
  const seenGitCredentials = new Set<string>();
  for (const skill of gitSkillSources) {
    const reference = skill.auth?.credentialArn ?? skill.auth?.credentialName;
    if (!reference) continue;
    const name = reference.includes("/")
      ? reference.slice(reference.lastIndexOf("/") + 1)
      : reference;
    if (seenGitCredentials.has(name)) continue;
    seenGitCredentials.add(name);
    if (!credentials.some((c) => c.name === name)) {
      credentials.push({ authorizerType: "ApiKeyCredentialProvider", name });
    }
    notes.push({
      category: GIT_SKILLS_AUTH_NOTE_CATEGORY,
      message:
        `The git skill ${skill.gitUrl} clones with the AgentCore Identity credential provider ` +
        `"${name}". A credential entry referencing it was added to agentcore.json so the ` +
        `deployed agent can fetch the token. The provider itself must already exist in ` +
        `AgentCore Identity.`,
    });
  }

  if (awsSkills.length > 0) {
    const patterns = awsSkills.map((s) => s.awsSkills.paths?.join(", ") ?? "all").join("; ");
    notes.push({
      category: AWS_SKILLS_NOTE_CATEGORY,
      message:
        `AWS skills are a managed harness feature and are not available in standalone Strands ` +
        `agents. The following skill patterns have been omitted: ${patterns}. You can copy the ` +
        `equivalent skills from https://github.com/aws/agent-toolkit-for-aws/tree/main/skills ` +
        `into your project and load them as path or git skills instead.`,
    });
  }

  return {
    hasSkillsFetcher: spec.skills.length > 0,
    hasFetchedSkills: s3SkillSources.length > 0 || gitSkillSources.length > 0,
    pathSkills,
    s3Skills: s3SkillSources.map((s) => s.s3Uri),
    gitSkills: gitSkillSources.map((s) => ({
      url: s.gitUrl,
      ...(s.path && { path: s.path }),
      ...((s.auth?.credentialArn ?? s.auth?.credentialName) && {
        credentialArn: s.auth!.credentialArn ?? s.auth!.credentialName,
      }),
      ...(s.auth?.username && { username: s.auth.username }),
    })),
    policyFiles,
  };
}

/**
 * Parse an s3:// skill URI into its bucket and object ARNs (undefined when the
 * URI has no bucket). S3 ARNs are region/account-less.
 */
export function parseS3SkillArns(
  s3Uri: string,
): { bucket: string; bucketArn: string; objectArn: string } | undefined {
  const withoutScheme = s3Uri.replace(/^s3:\/\//, "");
  const [bucket, ...prefixParts] = withoutScheme.split("/");
  if (!bucket) return undefined;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const prefix = prefixParts.join("/").replace(/\/+$/, "");
  const objectArn = prefix ? `${bucketArn}/${prefix}/*` : `${bucketArn}/*`;
  return { bucket, bucketArn, objectArn };
}

// ============================================================================
// Build type + Dockerfile
// ============================================================================

function resolveBuildType(spec: HarnessSpec, override?: BuildType): BuildType {
  if (override) return override;
  if (spec.containerUri || spec.dockerfile) return "Container";
  return "CodeZip";
}

function resolveDockerfilePlan(
  spec: HarnessSpec,
  buildType: BuildType,
  targetAgentName: string,
  harnessDockerfileExists: boolean,
  notes: ExportNote[],
): DockerfilePlan {
  if (buildType !== "Container") return { source: "none" };
  if (spec.containerUri) {
    notes.push({
      category: CONTAINER_URI_NOTE_CATEGORY,
      message:
        `The harness used a pre-built container image as its execution environment ` +
        `(${spec.containerUri}). The generated Dockerfile extends that image directly ` +
        `(FROM <containerUri>) and layers the Strands agent code on top. If your base image does ` +
        `not include Python 3.12+ or uv, add an install step before the \`uv sync\` steps. If ` +
        `the base image is a private ECR repository, also grant the CodeBuild project that ` +
        `builds this agent permission to pull it.`,
    });
    return { source: "stub", containerUri: spec.containerUri };
  }
  if (spec.dockerfile) {
    if (!harnessDockerfileExists) {
      notes.push({
        category: MISSING_DOCKERFILE_NOTE_CATEGORY,
        message:
          `The harness declares a custom Dockerfile, but no Dockerfile was found in its ` +
          `directory, so nothing was copied. Create app/${targetAgentName}/Dockerfile ` +
          `(including the Strands agent build layer) before \`agentcore project deploy\`.`,
      });
      return { source: "none" };
    }
    notes.push({
      category: CUSTOM_DOCKERFILE_NOTE_CATEGORY,
      message:
        `The harness used a custom Dockerfile that describes its execution environment. It has ` +
        `been copied to app/${targetAgentName}/Dockerfile unchanged, but the exported agent will ` +
        `NOT run as-is: a harness Dockerfile has no dependency install, code copy, or startup ` +
        `command (the harness runtime supplied those). Append the Strands agent build layer ` +
        `before \`agentcore project deploy\` (adjust if your base image is not Python 3.12+/uv):\n\n` +
        `  WORKDIR /app\n` +
        `  RUN pip install --no-cache-dir uv\n` +
        `  COPY pyproject.toml uv.lock ./\n` +
        `  RUN uv sync --frozen --no-dev --no-install-project\n` +
        `  COPY . .\n` +
        `  RUN uv sync --frozen --no-dev\n` +
        `  EXPOSE 8080\n` +
        `  CMD ["opentelemetry-instrument", "python", "-m", "main"]`,
    });
    return { source: "harnessCopy" };
  }
  return { source: "template" };
}

/** Dockerfile stub for a containerUri harness: extend the image, layer the agent on top. */
export function buildDockerfileStub(containerUri: string): string {
  return [
    `# Base image from the source harness: ${containerUri}`,
    "# The generated Strands agent is layered on top. If the base image does not",
    "# include Python 3.12+ or uv, add install steps before the COPY/RUN below.",
    `FROM ${containerUri}`,
    "",
    "RUN pip install --no-cache-dir uv",
    "",
    "WORKDIR /app",
    "",
    "ENV UV_SYSTEM_PYTHON=1 \\",
    "    UV_COMPILE_BYTECODE=1 \\",
    "    UV_NO_PROGRESS=1 \\",
    "    PYTHONUNBUFFERED=1 \\",
    '    PATH="/app/.venv/bin:$PATH"',
    "",
    "COPY pyproject.toml uv.lock ./",
    "RUN uv sync --frozen --no-dev --no-install-project",
    "",
    "COPY . .",
    "RUN uv sync --frozen --no-dev",
    "",
    "EXPOSE 8080 8000 9000",
    "",
    'CMD ["opentelemetry-instrument", "python", "-m", "main"]',
    "",
  ].join("\n");
}

// ============================================================================
// Filesystem mounts
// ============================================================================

function buildFilesystemConfigurations(
  spec: HarnessSpec,
): NonNullable<ProjectRuntime["filesystemConfigurations"]> {
  return [
    ...(spec.sessionStoragePath
      ? [{ sessionStorage: { mountPath: spec.sessionStoragePath } }]
      : []),
    ...(spec.efsAccessPoints ?? []).map((efsAccessPoint) => ({ efsAccessPoint })),
    ...(spec.s3AccessPoints ?? []).map((s3FilesAccessPoint) => ({ s3FilesAccessPoint })),
  ];
}

// ============================================================================
// Truncation
// ============================================================================

function resolveTruncationConfig(
  truncation: HarnessTruncationConfig | undefined,
): Record<string, unknown> | undefined {
  if (!truncation?.config) return undefined;
  const { strategy, config } = truncation;
  if (strategy === "sliding_window" && "slidingWindow" in config) {
    const sw = config.slidingWindow;
    return sw?.messagesCount !== undefined ? { window_size: sw.messagesCount } : undefined;
  }
  if (strategy === "summarization" && "summarization" in config) {
    const s = config.summarization as Record<string, unknown>;
    const keyMap: Record<string, string> = {
      summaryRatio: "summary_ratio",
      preserveRecentMessages: "preserve_recent_messages",
      summarizationSystemPrompt: "summarization_system_prompt",
    };
    const out = Object.fromEntries(
      Object.entries(keyMap)
        .filter(([key]) => s[key] !== undefined)
        .map(([key, target]) => [target, s[key]]),
    );
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

// ============================================================================
// allowedTools matching (mirrors the harness runtime's _matches() semantics)
// ============================================================================

export function matchesAllowedTools(toolName: string, patterns: string[]): boolean {
  if (patterns.includes("*")) return true;
  for (const pattern of patterns) {
    if (pattern === toolName) return true;
    if (pattern.startsWith("@")) {
      const slashIdx = pattern.indexOf("/", 1);
      const pServer = slashIdx === -1 ? pattern.slice(1) : pattern.slice(1, slashIdx);
      const pTool = slashIdx === -1 ? "*" : pattern.slice(slashIdx + 1);
      const slashInName = toolName.indexOf("/");
      if (slashInName === -1) {
        // MCP tools stored as "server_tool" flat names — keep legacy behaviour
        if (fnmatch(`${pServer}_${pTool}`, toolName)) return true;
      } else {
        // Qualified names like "builtin/shell"
        const nameServer = toolName.slice(0, slashInName);
        const nameTool = toolName.slice(slashInName + 1);
        if (fnmatch(pServer, nameServer) && fnmatch(pTool, nameTool)) return true;
      }
    } else if (fnmatch(pattern, toolName)) {
      return true;
    }
  }
  return false;
}

/** Builtins are keyed as "builtin/<name>": only @builtin or @builtin/<name> patterns match. */
function isBuiltinIncluded(builtinName: string, patterns: string[]): boolean {
  return matchesAllowedTools(`builtin/${builtinName}`, patterns);
}

function fnmatch(pattern: string, str: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(str);
}

// ============================================================================
// EXPORT_NOTES.md + display formatting
// ============================================================================

/** Render the EXPORT_NOTES.md content written into the exported agent's directory. */
export function buildExportNotesMarkdown(
  notes: ExportNote[],
  harnessName: string,
  agentName: string,
  strandsVersion: string,
): string {
  const today = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `# Export Notes — ${harnessName} → ${agentName}`,
    "",
    `Exported on: ${today}`,
    `Strands version: ${strandsVersion}`,
    `Source harness: ${harnessName}`,
    `Generated agent: app/${agentName}/`,
    "",
  ];

  if (notes.length === 0) {
    lines.push("No manual steps required.");
  } else {
    lines.push("## Items requiring manual follow-up");
    for (const note of notes) {
      lines.push("", `### ${note.category}`, note.message);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format export notes into styled lines for the export success path. Pure so the
 * CLI (and a future TUI screen) render identical wording.
 */
export function formatExportNotes(notes: ExportNote[], notesFileHint: string): ExportNoteLine[] {
  if (notes.length === 0) {
    return [{ text: `No manual follow-up required. (Details: ${notesFileHint})`, tone: "dim" }];
  }

  const label = notes.length === 1 ? "note" : "notes";
  const lines: ExportNoteLine[] = [
    { text: `${notes.length} export ${label} requiring manual follow-up:`, tone: "warn" },
  ];
  for (const note of notes) {
    lines.push({ text: `  - ${note.category}`, tone: "warn" });
    for (const messageLine of note.message.split("\n")) {
      lines.push({ text: `    ${messageLine}`, tone: "dim" });
    }
  }
  lines.push({ text: `These notes are also saved to ${notesFileHint}`, tone: "dim" });
  return lines;
}
