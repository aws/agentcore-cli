import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import type {
  AuthorizerConfiguration as SdkAuthorizerConfiguration,
  HarnessEnvironmentArtifact,
  HarnessEnvironmentProviderRequest,
  HarnessMemoryConfiguration as SdkMemoryConfiguration,
  HarnessModelConfiguration,
  HarnessSkill as SdkHarnessSkill,
  HarnessTool as SdkHarnessTool,
  HarnessTruncationConfiguration as SdkTruncationConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  HarnessMemoryRef,
  HarnessModel,
  HarnessSkill,
  HarnessTool,
  HarnessTruncationConfig,
  ManagedMemoryStrategy,
} from "../../../../projectSchemas/harness";
import type { AuthorizerConfig } from "../../../../projectSchemas/auth";

export const createAddHarnessHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description: "adds a harness to the active project",
    flags: [
      flag("name", "the name of the harness", z.string().optional()),
      flag(
        "execution-role-arn",
        "IAM role the harness assumes; a default role is created when omitted",
        z.string().optional(),
      ),
      flag("system-prompt", "the agent's system prompt", z.string().optional()),
      flag("model", "model configuration (JSON HarnessModelConfiguration)", z.string().optional()),
      flag("tools", "tools available to the agent (JSON HarnessTool[])", z.string().optional()),
      flag("skills", "skills available to the agent (JSON HarnessSkill[])", z.string().optional()),
      flag(
        "allowed-tools",
        "tool allowlist patterns (e.g. * or @serverName/toolName)",
        z.array(z.string()).optional(),
      ),
      flag(
        "memory",
        "memory configuration (JSON HarnessMemoryConfiguration)",
        z.string().optional(),
      ),
      flag(
        "truncation",
        "context truncation configuration (JSON HarnessTruncationConfiguration)",
        z.string().optional(),
      ),
      flag(
        "environment",
        "compute environment configuration (JSON HarnessEnvironmentProviderRequest)",
        z.string().optional(),
      ),
      flag(
        "environment-variables",
        "environment variables (JSON object of key/value strings)",
        z.string().optional(),
      ),
      flag(
        "environment-artifact",
        "environment artifact configuration (ex. container image) (JSON HarnessEnvironmentArtifact)",
        z.string().optional(),
      ),
      flag(
        "authorizer-configuration",
        "inbound authorizer configuration (JSON AuthorizerConfiguration)",
        z.string().optional(),
      ),
      flag("max-iterations", "max agent loop iterations per invocation", z.number().optional()),
      flag("max-tokens", "max total output tokens per invocation", z.number().optional()),
      flag("timeout-seconds", "max duration in seconds per invocation", z.number().optional()),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
      flag(
        "dockerfile",
        "path to local dockerfile to use as the container image for the harness",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      const inputModelConfig = parseJsonFlag<HarnessModelConfiguration>("model", flags["model"]);
      const inputTools = parseJsonFlag<SdkHarnessTool[]>("tools", flags["tools"]);
      const inputSkills = parseJsonFlag<SdkHarnessSkill[]>("skills", flags["skills"]);
      const inputMemory = parseJsonFlag<SdkMemoryConfiguration>("memory", flags["memory"]);
      const inputTruncation = parseJsonFlag<SdkTruncationConfiguration>(
        "truncation",
        flags["truncation"],
      );
      const inputAuthConfig = parseJsonFlag<SdkAuthorizerConfiguration>(
        "authorizer-configuration",
        flags["authorizer-configuration"],
      );
      const inputEnvironment = parseJsonFlag<HarnessEnvironmentProviderRequest>(
        "environment",
        flags["environment"],
      );
      const inputArtifact = parseJsonFlag<HarnessEnvironmentArtifact>(
        "environment-artifact",
        flags["environment-artifact"],
      );
      const env = inputEnvironment ? toEnvironment(inputEnvironment) : undefined;
      const artifact = inputArtifact ? toEnvironmentArtifact(inputArtifact) : undefined;

      if (inputArtifact?.containerConfiguration?.containerUri && flags.dockerfile)
        throw new InputValidationError(`containerUri and dockerfile are mutually exclusive`);

      const harnessConfig = {
        name: flags.name,
        model: inputModelConfig
          ? toModelConfig(inputModelConfig)
          : { provider: "bedrock" as const, modelId: "global.anthropic.claude-sonnet-4-6" },
        systemPrompt: flags["system-prompt"],
        executionRoleArn: flags["execution-role-arn"],
        tools: inputTools?.map(toTool),
        skills: inputSkills?.map(toSkill),
        allowedTools: flags["allowed-tools"],
        memory: inputMemory ? toMemory(inputMemory) : undefined,
        truncation: inputTruncation ? toTruncation(inputTruncation) : undefined,
        environmentVariables: parseJsonFlag<Record<string, string>>(
          "environment-variables",
          flags["environment-variables"],
        ),
        authorizerType: inputAuthConfig ? ("CUSTOM_JWT" as const) : undefined,
        authorizerConfiguration: inputAuthConfig ? toAuthorizerConfig(inputAuthConfig) : undefined,
        maxIterations: flags["max-iterations"],
        maxTokens: flags["max-tokens"],
        timeoutSeconds: flags["timeout-seconds"],
        tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
        networkMode: env?.networkMode,
        networkConfig: env?.networkConfig,
        lifecycleConfig: env?.lifecycleConfig,
        sessionStoragePath: env?.sessionStoragePath,
        efsAccessPoints: env?.efsAccessPoints,
        s3AccessPoints: env?.s3AccessPoints,
        containerUri: artifact?.containerUri,
        dockerfile: flags["dockerfile"],
      };

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.add(project, "harness", harnessConfig)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added harness '${flags["name"]}' to '${project.name}'`);
    },
  });

/** Converts the SDK's tagged-union model config into the flat project-schema shape. */
function toModelConfig(modelConfig: HarnessModelConfiguration): HarnessModel {
  function commonFields(c: {
    modelId?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    additionalParams?: unknown;
  }) {
    if (!c.modelId) throw new InputValidationError("modelId is required in model configuration");
    return {
      modelId: c.modelId,
      maxTokens: c.maxTokens,
      temperature: c.temperature,
      topP: c.topP,
      additionalParams: c.additionalParams as Record<string, unknown> | undefined,
    };
  }

  if ("bedrockModelConfig" in modelConfig && modelConfig.bedrockModelConfig) {
    const c = modelConfig.bedrockModelConfig;
    return { provider: "bedrock", ...commonFields(c), apiFormat: c.apiFormat };
  }
  if ("openAiModelConfig" in modelConfig && modelConfig.openAiModelConfig) {
    const c = modelConfig.openAiModelConfig;
    return {
      provider: "open_ai",
      ...commonFields(c),
      apiKeyArn: c.apiKeyArn,
      apiFormat: c.apiFormat,
    };
  }
  if ("geminiModelConfig" in modelConfig && modelConfig.geminiModelConfig) {
    const c = modelConfig.geminiModelConfig;
    return { provider: "gemini", ...commonFields(c), apiKeyArn: c.apiKeyArn, topK: c.topK };
  }
  if ("liteLlmModelConfig" in modelConfig && modelConfig.liteLlmModelConfig) {
    const c = modelConfig.liteLlmModelConfig;
    return { provider: "lite_llm", ...commonFields(c), apiKeyArn: c.apiKeyArn, apiBase: c.apiBase };
  }
  throw new InputValidationError("Unrecognized model configuration variant");
}

/** Converts an SDK HarnessTool into the flat project-schema shape. */
function toTool(tool: SdkHarnessTool): HarnessTool {
  if (!tool.type) throw new InputValidationError("tool type is required");
  if (!tool.name) throw new InputValidationError(`tool name is required (type: ${tool.type})`);
  if (!tool.config) return { type: tool.type, name: tool.name };
  const c = tool.config;
  if ("remoteMcp" in c && c.remoteMcp) {
    return {
      type: tool.type,
      name: tool.name,
      config: { remoteMcp: { url: c.remoteMcp.url!, headers: c.remoteMcp.headers } },
    };
  }
  if ("agentCoreBrowser" in c && c.agentCoreBrowser) {
    return {
      type: tool.type,
      name: tool.name,
      config: { agentCoreBrowser: { browserArn: c.agentCoreBrowser.browserArn } },
    };
  }
  if ("agentCoreGateway" in c && c.agentCoreGateway) {
    return {
      type: tool.type,
      name: tool.name,
      config: { agentCoreGateway: { gatewayArn: c.agentCoreGateway.gatewayArn! } },
    };
  }
  if ("inlineFunction" in c && c.inlineFunction) {
    return {
      type: tool.type,
      name: tool.name,
      config: {
        inlineFunction: {
          description: c.inlineFunction.description!,
          inputSchema: c.inlineFunction.inputSchema as Record<string, unknown>,
        },
      },
    };
  }
  if ("agentCoreCodeInterpreter" in c && c.agentCoreCodeInterpreter) {
    return {
      type: tool.type,
      name: tool.name,
      config: {
        agentCoreCodeInterpreter: {
          codeInterpreterArn: c.agentCoreCodeInterpreter.codeInterpreterArn,
        },
      },
    };
  }
  return { type: tool.type, name: tool.name };
}

/** Converts an SDK HarnessSkill tagged union into the project-schema shape. */
function toSkill(skill: SdkHarnessSkill): HarnessSkill {
  if ("path" in skill && skill.path) {
    return { path: skill.path };
  }
  if ("s3" in skill && skill.s3) {
    return { s3Uri: skill.s3.uri! };
  }
  if ("git" in skill && skill.git) {
    return {
      gitUrl: skill.git.url!,
      path: skill.git.path,
      auth: skill.git.auth
        ? { credentialName: skill.git.auth.credentialArn!, username: skill.git.auth.username }
        : undefined,
    };
  }
  if ("awsSkills" in skill && skill.awsSkills) {
    return { awsSkills: { paths: skill.awsSkills.paths } };
  }
  throw new InputValidationError("Unrecognized skill variant");
}

/** Converts an SDK HarnessMemoryConfiguration tagged union into the project-schema shape. */
function toMemory(memory: SdkMemoryConfiguration): HarnessMemoryRef {
  if ("managedMemoryConfiguration" in memory && memory.managedMemoryConfiguration) {
    const c = memory.managedMemoryConfiguration;
    return {
      mode: "managed",
      strategies: c.strategies as ManagedMemoryStrategy[] | undefined,
      eventExpiryDuration: c.eventExpiryDuration,
      encryptionKeyArn: c.encryptionKeyArn,
    };
  }
  if ("agentCoreMemoryConfiguration" in memory && memory.agentCoreMemoryConfiguration) {
    const c = memory.agentCoreMemoryConfiguration;
    return {
      mode: "existing",
      arn: c.arn,
      actorId: c.actorId,
      messagesCount: c.messagesCount,
    };
  }
  if ("disabled" in memory && memory.disabled) {
    return { mode: "disabled" };
  }
  throw new InputValidationError("Unrecognized memory configuration variant");
}

/** Converts an SDK HarnessTruncationConfiguration into the project-schema shape. */
function toTruncation(truncation: SdkTruncationConfiguration): HarnessTruncationConfig {
  if (!truncation.strategy) throw new InputValidationError("truncation strategy is required");
  const config = truncation.config;
  if (!config) return { strategy: truncation.strategy };
  if ("slidingWindow" in config && config.slidingWindow) {
    return {
      strategy: truncation.strategy,
      config: { slidingWindow: { messagesCount: config.slidingWindow.messagesCount } },
    };
  }
  if ("summarization" in config && config.summarization) {
    return {
      strategy: truncation.strategy,
      config: {
        summarization: {
          summaryRatio: config.summarization.summaryRatio,
          preserveRecentMessages: config.summarization.preserveRecentMessages,
          summarizationSystemPrompt: config.summarization.summarizationSystemPrompt,
        },
      },
    };
  }
  return { strategy: truncation.strategy };
}

/** Converts an SDK AuthorizerConfiguration tagged union into the project-schema shape. */
function toAuthorizerConfig(auth: SdkAuthorizerConfiguration): AuthorizerConfig {
  if ("customJWTAuthorizer" in auth && auth.customJWTAuthorizer) {
    const c = auth.customJWTAuthorizer;
    if (!c.discoveryUrl)
      throw new InputValidationError("discoveryUrl is required in authorizer configuration");
    return {
      customJwtAuthorizer: {
        discoveryUrl: c.discoveryUrl,
        allowedAudience: c.allowedAudience,
        allowedClients: c.allowedClients,
        allowedScopes: c.allowedScopes,
      },
    };
  }
  throw new InputValidationError("Unrecognized authorizer configuration variant");
}

/** Decomposes the SDK's environment tagged union into flat HarnessSpec fields. */
function toEnvironment(env: HarnessEnvironmentProviderRequest) {
  if (!("agentCoreRuntimeEnvironment" in env) || !env.agentCoreRuntimeEnvironment) {
    throw new InputValidationError("Unrecognized environment configuration variant");
  }
  const rt = env.agentCoreRuntimeEnvironment;
  const net = rt.networkConfiguration;
  const fss = rt.filesystemConfigurations ?? [];

  const sessionStorage = fss.find((f) => "sessionStorage" in f && f.sessionStorage);
  const efsAccessPoints = fss.filter((f) => "efsAccessPoint" in f && f.efsAccessPoint);
  const s3AccessPoints = fss.filter((f) => "s3FilesAccessPoint" in f && f.s3FilesAccessPoint);

  return {
    networkMode: net?.networkMode as "PUBLIC" | "VPC" | undefined,
    networkConfig: net?.networkModeConfig
      ? {
          subnets: net.networkModeConfig.subnets!,
          securityGroups: net.networkModeConfig.securityGroups!,
        }
      : undefined,
    lifecycleConfig: rt.lifecycleConfiguration
      ? {
          idleRuntimeSessionTimeout: rt.lifecycleConfiguration.idleRuntimeSessionTimeout,
          maxLifetime: rt.lifecycleConfiguration.maxLifetime,
        }
      : undefined,
    sessionStoragePath:
      sessionStorage && "sessionStorage" in sessionStorage
        ? sessionStorage.sessionStorage!.mountPath!
        : undefined,
    efsAccessPoints:
      efsAccessPoints.length > 0
        ? efsAccessPoints.map((f) => {
            const efs = "efsAccessPoint" in f ? f.efsAccessPoint! : undefined;
            return { accessPointArn: efs!.accessPointArn!, mountPath: efs!.mountPath! };
          })
        : undefined,
    s3AccessPoints:
      s3AccessPoints.length > 0
        ? s3AccessPoints.map((f) => {
            const s3 = "s3FilesAccessPoint" in f ? f.s3FilesAccessPoint! : undefined;
            return { accessPointArn: s3!.accessPointArn!, mountPath: s3!.mountPath! };
          })
        : undefined,
  };
}

/** Decomposes the SDK's environment artifact tagged union into flat HarnessSpec fields. */
function toEnvironmentArtifact(artifact: HarnessEnvironmentArtifact) {
  if ("containerConfiguration" in artifact && artifact.containerConfiguration) {
    return { containerUri: artifact.containerConfiguration.containerUri! };
  }
  throw new InputValidationError("Unrecognized environment artifact variant");
}
