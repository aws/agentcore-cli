import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { RuntimeResourceConfig } from "../../../handlers/project/add/runtime/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { mergeSpecEntries } from "./spec";
import type { SpecEntries, TemplateRenderer, TemplateResolver } from "./types";
import type {
  EnvLocalEntry,
  ModelProvider,
  ScaffoldRuntimeInput,
} from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { defaultMemoryName, memoryEnvVarName } from "../../../projectSchemas/memory";
import { InputValidationError } from "../../../errors";
import { toPythonPackageName } from "../fsUtils";
import { templateUsesModel } from "../../../handlers/project/templateProfile";
import { resolveRuntimeTemplateProfile } from "../../../handlers/project/runtimeTemplateProfile";

/** A model provider's render context, spec entries, and .env.local secrets for a scaffolded runtime. */
type ModelProviderTemplateConfig = {
  templateRenderContext: { identityProviders: { name: string; envVarName: string }[] };
  spec: SpecEntries;
  envEntries: EnvLocalEntry[];
};

/** The model id each provider block renders when the user does not pass one. */
const DEFAULT_MODEL_IDS: Record<ModelProvider, string> = {
  Bedrock: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  Anthropic: "claude-sonnet-4-5-20250929",
  OpenAI: "gpt-4.1",
  Gemini: "gemini-2.5-flash",
  LiteLLM: "bedrock/us.anthropic.claude-sonnet-4-5-20250514-v1:0",
};

function resolveModelProviderScaffold(input: RuntimeResourceConfig): ModelProviderTemplateConfig {
  const { modelProvider, apiKey } = input.scaffoldRuntimeInput;
  if (apiKey === undefined) {
    return { templateRenderContext: { identityProviders: [] }, spec: {}, envEntries: [] };
  }
  const credentialName = `${input.name}${modelProvider}ApiKey`;
  const envVarName = credentialEnvVarName(credentialName);
  return {
    templateRenderContext: { identityProviders: [{ name: credentialName, envVarName }] },
    spec: { credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: credentialName }] },
    envEntries: [
      {
        key: envVarName,
        value: apiKey,
        comment: `API key for the ${modelProvider} model provider (runtime ${input.name})`,
      },
    ],
  };
}

function buildRuntimeSpec(input: RuntimeResourceConfig): ProjectRuntime {
  const { scaffoldRuntimeInput, name, ...infra } = input;
  const profile = resolveRuntimeTemplateProfile(scaffoldRuntimeInput);
  const runtimeProfile = profile?.runtime;
  const usesModel = templateUsesModel(profile);
  const lifecycleConfiguration = mergeLifecycleConfiguration(
    runtimeProfile?.lifecycleConfiguration,
    infra.lifecycleConfiguration,
  );
  const additionalPolicies = unique([
    ...(runtimeProfile?.additionalPolicies ?? []),
    ...(infra.additionalPolicies ?? []),
  ]);
  const tags =
    runtimeProfile?.tags || infra.tags ? { ...runtimeProfile?.tags, ...infra.tags } : undefined;
  return {
    name,
    build: scaffoldRuntimeInput.build,
    // Persist the provider actually wired into the scaffolded code so the
    // China deploy gate can classify this runtime later: framework scaffolds
    // and Bedrock Agent imports (whose translated code calls Bedrock despite
    // framework "none"). Provider-free scaffolds (minimal, MCP) stay
    // unclassified.
    ...(usesModel &&
      (scaffoldRuntimeInput.framework !== "none" || input.importBedrockAgent !== undefined) && {
        modelProvider: scaffoldRuntimeInput.modelProvider ?? "Bedrock",
      }),
    // For LiteLLM the model id determines the actual routing (its 'bedrock/'
    // prefix routes to Amazon Bedrock), so persist the id the code renders —
    // explicit --model-id or the template default — for the China deploy gate.
    ...(usesModel &&
      scaffoldRuntimeInput.modelProvider === "LiteLLM" && {
        modelId: scaffoldRuntimeInput.modelId ?? DEFAULT_MODEL_IDS.LiteLLM,
      }),
    // TypeScript deploys a compiled main.js (esbuild runs at synth); Python runs main.py directly.
    entrypoint:
      runtimeProfile?.entrypoint ??
      (scaffoldRuntimeInput.language === "TypeScript" ? "main.js" : "main.py"),
    codeLocation: `app/${name}` as ProjectRuntime["codeLocation"],
    ...(scaffoldRuntimeInput.runtimeVersion && {
      runtimeVersion: scaffoldRuntimeInput.runtimeVersion,
    }),
    ...(scaffoldRuntimeInput.build === "Container" && {
      dockerfile: runtimeProfile?.dockerfile ?? "Dockerfile",
    }),
    ...(infra.description && { description: infra.description }),
    ...(infra.executionRoleArn && { executionRoleArn: infra.executionRoleArn }),
    ...(additionalPolicies.length > 0 && { additionalPolicies }),
    ...(infra.envVars && { envVars: infra.envVars }),
    ...(infra.networkMode && { networkMode: infra.networkMode }),
    ...(infra.networkConfig && { networkConfig: infra.networkConfig }),
    ...(infra.authorizerType && { authorizerType: infra.authorizerType }),
    ...(infra.authorizerConfiguration && {
      authorizerConfiguration: infra.authorizerConfiguration,
    }),
    ...(infra.protocol && { protocol: infra.protocol }),
    ...(infra.requestHeaderAllowlist && { requestHeaderAllowlist: infra.requestHeaderAllowlist }),
    ...(lifecycleConfiguration && { lifecycleConfiguration }),
    ...(infra.filesystemConfigurations && {
      filesystemConfigurations: infra.filesystemConfigurations,
    }),
    ...(tags && { tags }),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Merge lifecycle defaults without allowing an inherited value to invalidate an
 * explicit value. If both explicit values conflict, ProjectRuntimeSchema still
 * reports the error.
 */
function mergeLifecycleConfiguration(
  defaults: ProjectRuntime["lifecycleConfiguration"],
  overrides: ProjectRuntime["lifecycleConfiguration"],
): ProjectRuntime["lifecycleConfiguration"] {
  if (!defaults) return overrides;
  if (!overrides) return defaults;

  let idleRuntimeSessionTimeout =
    overrides.idleRuntimeSessionTimeout ?? defaults.idleRuntimeSessionTimeout;
  let maxLifetime = overrides.maxLifetime ?? defaults.maxLifetime;

  if (
    idleRuntimeSessionTimeout !== undefined &&
    maxLifetime !== undefined &&
    idleRuntimeSessionTimeout > maxLifetime
  ) {
    if (overrides.idleRuntimeSessionTimeout !== undefined && overrides.maxLifetime === undefined) {
      maxLifetime = idleRuntimeSessionTimeout;
    } else if (
      overrides.maxLifetime !== undefined &&
      overrides.idleRuntimeSessionTimeout === undefined
    ) {
      idleRuntimeSessionTimeout = maxLifetime;
    }
  }

  return {
    ...(idleRuntimeSessionTimeout !== undefined && { idleRuntimeSessionTimeout }),
    ...(maxLifetime !== undefined && { maxLifetime }),
  };
}

/**
 * Normalize a name for use as an npm package name.
 *
 * @param name - The raw runtime/project name to normalize.
 * @returns An npm-safe package name.
 * @see {@link https://github.com/npm/validate-npm-package-name} for npm's package name rules.
 */
function toNpmPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
}

function buildResolverKey(
  framework: ScaffoldRuntimeInput["framework"],
  language: ScaffoldRuntimeInput["language"],
  protocol: ScaffoldRuntimeInput["protocol"],
): `${ScaffoldRuntimeInput["framework"]}/${ScaffoldRuntimeInput["language"]}/${NonNullable<ScaffoldRuntimeInput["protocol"]>}` {
  return `${framework}/${language}/${protocol ?? "HTTP"}`;
}

const importBedrockAgentResolver = () => async (input: RuntimeResourceConfig) => {
  const imported = input.importBedrockAgent!;
  if (input.protocol !== undefined && input.protocol !== "HTTP")
    throw new InputValidationError("an imported Bedrock Agent only supports HTTP");

  const tree = FsTreeNode.createDirectory(
    input.name,
    Object.entries(imported.files).map(([name, content]) => {
      if (name.includes("/") || name === "." || name === "..") {
        throw new InputValidationError(`unsafe imported file name: '${name}'`);
      }
      return FsTreeNode.createFile(name, async () => content);
    }),
  );

  const memory = input.scaffoldRuntimeInput.memory;
  return {
    tree,
    spec: {
      runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }],
      ...(memory && { memories: [memory] }),
    },
  };
};

const getTemplateResolvers = (assetSource: AssetSource, templateRenderer: TemplateRenderer) => ({
  [buildResolverKey("none", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agent-python-minimal" },
      {
        rootDirName: input.name,
        transformContent: (raw) =>
          templateRenderer.render(raw, { name: toPythonPackageName(input.name) }),
      },
    );
    return { tree, spec: { runtimes: [buildRuntimeSpec(input)] } };
  },
  [buildResolverKey("langchain", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agent-python-langchain" },
      {
        rootDirName: input.name,
        transformContent: (raw) =>
          templateRenderer.render(raw, { name: toPythonPackageName(input.name) }),
      },
    );
    return {
      tree,
      spec: { runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }] },
    };
  },
  [buildResolverKey("strands", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
    const memory = input.scaffoldRuntimeInput.memory;
    const modelScaffold = resolveModelProviderScaffold(input);
    const modelProvider = input.scaffoldRuntimeInput.modelProvider ?? "Bedrock";
    const context = {
      name: toPythonPackageName(input.name),
      modelProvider,
      modelId: input.scaffoldRuntimeInput.modelId ?? DEFAULT_MODEL_IDS[modelProvider],
      // Even without a memory resource (China scaffolds omit it — AgentCore
      // Memory is not available there), the rendered module reads the default
      // memory's env var so adding a memory later needs no code edit.
      memoryEnvVarName: memoryEnvVarName(memory?.name ?? defaultMemoryName(input.name)),
      ...modelScaffold.templateRenderContext,
      enableOtel: true,
      // The strands template's entrypoint is fixed to main.py; the container Dockerfile launches it as the `main` module.
      entrypoint: "main",
    };
    const isContainer = input.scaffoldRuntimeInput.build === "Container";
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agent-python-strands" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name) => {
          // The memory module is always included: main.py imports it
          // unconditionally and it degrades to no memory when its env var is
          // absent (the China scaffold omits the memory resource).
          if (name === "Dockerfile" || name === ".dockerignore") return isContainer;
          return true;
        },
      },
    );
    return {
      tree,
      spec: mergeSpecEntries([
        {
          runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }],
          ...(memory && { memories: [memory] }),
        },
        modelScaffold.spec,
      ]),
      ...(modelScaffold.envEntries.length > 0 && { envEntries: modelScaffold.envEntries }),
    };
  },
  [buildResolverKey("strands", "TypeScript", "HTTP")]: async (input: RuntimeResourceConfig) => {
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError("the agent-typescript-strands template only supports HTTP");
    const memory = input.scaffoldRuntimeInput.memory;
    const modelScaffold = resolveModelProviderScaffold(input);
    const context = {
      name: toNpmPackageName(input.name),
      runtimeName: input.name,
      memoryEnvVarName: memory ? memoryEnvVarName(memory.name) : undefined,
      ...modelScaffold.templateRenderContext,
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agent-typescript-strands" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          return true;
        },
      },
    );
    return {
      tree,
      spec: mergeSpecEntries([
        {
          runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }],
          ...(memory && { memories: [memory] }),
        },
        modelScaffold.spec,
      ]),
      ...(modelScaffold.envEntries.length > 0 && { envEntries: modelScaffold.envEntries }),
    };
  },
  [buildResolverKey("vercelai", "TypeScript", "HTTP")]: async (input: RuntimeResourceConfig) => {
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError("the agent-typescript-vercel template only supports HTTP");
    const context = { name: toNpmPackageName(input.name) };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agent-typescript-vercel" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
      },
    );
    return {
      tree,
      spec: { runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }] },
    };
  },
  [buildResolverKey("bma", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/bedrock-managed-agents" },
      {
        rootDirName: input.name,
        transformContent: (raw) =>
          templateRenderer.render(raw, { name: toPythonPackageName(input.name) }),
      },
    );
    return {
      tree,
      spec: { runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }] },
    };
  },
  [buildResolverKey("none", "Python", "MCP")]: async (input: RuntimeResourceConfig) => {
    if (input.scaffoldRuntimeInput.modelProvider !== undefined)
      throw new InputValidationError("an MCP runtime does not use a model provider");
    if (input.scaffoldRuntimeInput.memory !== undefined)
      throw new InputValidationError("memory is not supported with an MCP runtime");
    const filesystemConfigurations = input.filesystemConfigurations ?? [];
    const sessionStorageMountPath = filesystemConfigurations.flatMap((configuration) =>
      "sessionStorage" in configuration ? [configuration.sessionStorage.mountPath] : [],
    )[0];
    const efsMounts = filesystemConfigurations.flatMap((configuration) =>
      "efsAccessPoint" in configuration
        ? [{ mountPath: configuration.efsAccessPoint.mountPath }]
        : [],
    );
    const s3Mounts = filesystemConfigurations.flatMap((configuration) =>
      "s3FilesAccessPoint" in configuration
        ? [{ mountPath: configuration.s3FilesAccessPoint.mountPath }]
        : [],
    );
    const context = {
      name: toPythonPackageName(input.name),
      sessionStorageMountPath,
      efsMounts,
      s3Mounts,
      needsOs: filesystemConfigurations.length > 0,
      // The AgentCore Runtime requires OTEL dependencies to be present; the
      // container launches main.py as the `main` module under
      // opentelemetry-instrument, and FastMCP binds the streamable-HTTP server.
      enableOtel: true,
      entrypoint: "main",
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/mcp-python-fastmcp" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
      },
    );
    return {
      tree,
      spec: { runtimes: [{ ...buildRuntimeSpec(input), protocol: "MCP" as const }] },
    };
  },
  [buildResolverKey("strands", "Python", "A2A")]: async (input: RuntimeResourceConfig) => {
    const filesystemConfigurations = input.filesystemConfigurations ?? [];
    const sessionStorageMountPath = filesystemConfigurations.flatMap((configuration) =>
      "sessionStorage" in configuration ? [configuration.sessionStorage.mountPath] : [],
    )[0];
    const efsMounts = filesystemConfigurations.flatMap((configuration) =>
      "efsAccessPoint" in configuration
        ? [{ mountPath: configuration.efsAccessPoint.mountPath }]
        : [],
    );
    const s3Mounts = filesystemConfigurations.flatMap((configuration) =>
      "s3FilesAccessPoint" in configuration
        ? [{ mountPath: configuration.s3FilesAccessPoint.mountPath }]
        : [],
    );
    const memory = input.scaffoldRuntimeInput.memory;
    const modelScaffold = resolveModelProviderScaffold(input);
    const context = {
      name: toPythonPackageName(input.name),
      memoryEnvVarName: memory ? memoryEnvVarName(memory.name) : undefined,
      ...modelScaffold.templateRenderContext,
      sessionStorageMountPath,
      efsMounts,
      s3Mounts,
      needsOs: filesystemConfigurations.length > 0,
      // The AgentCore Runtime requires OTEL dependencies to be present; the
      // container launches main.py as the `main` module under
      // opentelemetry-instrument, and serve_a2a binds the A2A server on port 9000.
      enableOtel: true,
      entrypoint: "main",
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/a2a-python-strands" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          return true;
        },
      },
    );
    return {
      tree,
      spec: mergeSpecEntries([
        {
          runtimes: [{ ...buildRuntimeSpec(input), protocol: "A2A" as const }],
          ...(memory && { memories: [memory] }),
        },
        modelScaffold.spec,
      ]),
      ...(modelScaffold.envEntries.length > 0 && { envEntries: modelScaffold.envEntries }),
    };
  },
  [buildResolverKey("strands", "Python", "AGUI")]: async (input: RuntimeResourceConfig) => {
    const memory = input.scaffoldRuntimeInput.memory;
    const context = {
      name: toPythonPackageName(input.name),
      memoryEnvVarName: memory ? memoryEnvVarName(memory.name) : undefined,
      // The AgentCore Runtime requires OTEL dependencies to be present; the AG-UI
      // app binds uvicorn on port 8080 under opentelemetry-instrument.
      enableOtel: true,
      entrypoint: "main",
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/agui-python-strands" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          return true;
        },
      },
    );
    return {
      tree,
      spec: {
        runtimes: [{ ...buildRuntimeSpec(input), protocol: "AGUI" as const }],
        ...(memory && { memories: [memory] }),
      },
    };
  },
});

type GetRuntimeTemplateResolverConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};

/** Given the parameters for rendering, load the {@link TemplateResolver} that resolves to the correct template **/
export function getRuntimeTemplateResolver(
  config: GetRuntimeTemplateResolverConfig,
  input: RuntimeResourceConfig,
): TemplateResolver<RuntimeResourceConfig> | undefined {
  // An imported Bedrock Agent carries a complete translated file plan, so it
  // bypasses the normal framework/language template lookup.
  if (input.importBedrockAgent) {
    return { resolve: importBedrockAgentResolver() };
  }

  const { framework, language, protocol } = input.scaffoldRuntimeInput;
  const key = buildResolverKey(framework, language, protocol);

  const resolve = getTemplateResolvers(config.assetSource, config.templateRenderer)[key];
  if (!resolve) return undefined;
  return { resolve };
}
