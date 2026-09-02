import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { RuntimeResourceConfig } from "../../../handlers/project/add/runtime/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { TemplateRenderer, TemplateResolver } from "./types";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { InputValidationError } from "../../../errors";
import { toPythonPackageName } from "../fsUtils";

function buildRuntimeSpec(input: RuntimeResourceConfig): ProjectRuntime {
  const { scaffoldRuntimeInput, name, ...infra } = input;
  return {
    name,
    build: scaffoldRuntimeInput.build,
    // TypeScript deploys a compiled main.js (esbuild runs at synth); Python runs main.py directly.
    entrypoint: scaffoldRuntimeInput.language === "TypeScript" ? "main.js" : "main.py",
    codeLocation: `app/${name}` as ProjectRuntime["codeLocation"],
    ...(scaffoldRuntimeInput.runtimeVersion && {
      runtimeVersion: scaffoldRuntimeInput.runtimeVersion,
    }),
    ...(scaffoldRuntimeInput.build === "Container" && { dockerfile: "Dockerfile" }),
    ...(infra.description && { description: infra.description }),
    ...(infra.executionRoleArn && { executionRoleArn: infra.executionRoleArn }),
    ...(infra.additionalPolicies && { additionalPolicies: infra.additionalPolicies }),
    ...(infra.envVars && { envVars: infra.envVars }),
    ...(infra.networkMode && { networkMode: infra.networkMode }),
    ...(infra.networkConfig && { networkConfig: infra.networkConfig }),
    ...(infra.authorizerType && { authorizerType: infra.authorizerType }),
    ...(infra.authorizerConfiguration && {
      authorizerConfiguration: infra.authorizerConfiguration,
    }),
    ...(infra.protocol && { protocol: infra.protocol }),
    ...(infra.requestHeaderAllowlist && { requestHeaderAllowlist: infra.requestHeaderAllowlist }),
    ...(infra.lifecycleConfiguration && { lifecycleConfiguration: infra.lifecycleConfiguration }),
    ...(infra.filesystemConfigurations && {
      filesystemConfigurations: infra.filesystemConfigurations,
    }),
    ...(infra.tags && { tags: infra.tags }),
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

// The IAM policy file the proxy template vends; wired into the runtime's
// additionalPolicies so the execution role may call bedrock:InvokeAgent.
const BEDROCK_AGENT_POLICY_FILE = "bedrock-agent-policy.json";

const importBedrockAgentResolver =
  (assetSource: AssetSource, templateRenderer: TemplateRenderer) =>
  async (input: RuntimeResourceConfig) => {
    const imported = input.importBedrockAgent!;
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError("an imported Bedrock Agent proxy only supports HTTP");

    const context = {
      name: toPythonPackageName(input.name),
      agentId: imported.agentId,
      agentAliasId: imported.agentAliasId,
      agentRegion: imported.region,
      agentName: imported.agentName,
      agentAliasArn: imported.agentAliasArn,
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/bedrock-agent-proxy-python" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
      },
    );

    const base = buildRuntimeSpec(input);
    return {
      tree,
      spec: {
        runtimes: [
          {
            ...base,
            protocol: "HTTP" as const,
            additionalPolicies: [...(base.additionalPolicies ?? []), BEDROCK_AGENT_POLICY_FILE],
          },
        ],
      },
    };
  };

const getTemplateResolvers = (assetSource: AssetSource, templateRenderer: TemplateRenderer) => ({
  [buildResolverKey("none", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
    if (input.scaffoldRuntimeInput.memory !== undefined)
      throw new InputValidationError(`memory is not supported with the hello-world template`);
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      {
        assetDir:
          input.scaffoldRuntimeInput.build === "Container"
            ? "templates/hello-world-python-container"
            : "templates/hello-world-python",
      },
      { rootDirName: input.name },
    );
    return { tree, spec: { runtimes: [buildRuntimeSpec(input)] } };
  },
  [buildResolverKey("strands", "Python", "HTTP")]: async (input: RuntimeResourceConfig) => {
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
    const context = {
      name: toPythonPackageName(input.name),
      modelProvider: input.scaffoldRuntimeInput.modelProvider,
      hasMemory: memory !== undefined,
      // the CDK injects this env var corresponding to the actual ID once its resolved on deployment.
      memoryEnvVarName: memory ? `MEMORY_${memory.name.toUpperCase()}_ID` : undefined,
      memoryStrategies: memory?.strategies.map(({ type }) => type) ?? [],
      hasIdentity: false,
      hasGateway: false,
      hasPayment: false,
      isVpc: input.networkMode === "VPC",
      identityProviders: [],
      gatewayProviders: [],
      gatewayAuthTypes: [],
      sessionStorageMountPath,
      efsMounts,
      s3Mounts,
      needsOs: filesystemConfigurations.length > 0,
      hasConfigBundle: false,
      enableOtel: true,
      // The strands template's entrypoint is fixed to main.py; the container Dockerfile launches it as the `main` module.
      entrypoint: "main",
    };
    const isContainer = input.scaffoldRuntimeInput.build === "Container";
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/strands-http-python" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          // hooks/ carries the execution-limits capability, which only
          // `project export harness` renders (harnesses can cap
          // iterations/tokens/time; scaffolded runtimes cannot).
          if (isDir && name === "hooks") return false;
          if (name === "Dockerfile" || name === ".dockerignore") return isContainer;
          return true;
        },
      },
    );
    return {
      tree,
      spec: {
        runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }],
        ...(memory && { memories: [memory] }),
      },
    };
  },
  [buildResolverKey("strands", "TypeScript", "HTTP")]: async (input: RuntimeResourceConfig) => {
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError("the strands-ts template only supports HTTP");

    const memory = input.scaffoldRuntimeInput.memory;
    // The TypeScript strands SDK's createAgentCoreMemoryStores requires at least one
    // namespace, so short-term-only memory (no long-term strategies) is unsupported.
    // https://github.com/aws/bedrock-agentcore-sdk-typescript/blob/v0.3.0/src/memory/integrations/strands/factory.ts#L130-L133
    if (memory !== undefined && memory.strategies.length === 0)
      throw new InputValidationError(
        "the strands-ts template does not support short-term-only memory; add long-term strategies or use --memory none",
      );

    const context = {
      name: toNpmPackageName(input.name),
      modelProvider: input.scaffoldRuntimeInput.modelProvider,
      hasMemory: memory !== undefined,
      // the CDK injects this env var corresponding to the actual ID once its resolved on deployment.
      memoryEnvVarName: memory ? `MEMORY_${memory.name.toUpperCase()}_ID` : undefined,
      memoryStrategies: memory?.strategies.map(({ type }) => type) ?? [],
      hasIdentity: false,
      identityProviders: [],
    };
    const isContainer = input.scaffoldRuntimeInput.build === "Container";
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/strands-http-typescript" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          if (name === "Dockerfile" || name === ".dockerignore") return isContainer;
          return true;
        },
      },
    );
    return {
      tree,
      spec: {
        runtimes: [{ ...buildRuntimeSpec(input), protocol: "HTTP" as const }],
        ...(memory && { memories: [memory] }),
      },
    };
  },
  [buildResolverKey("none", "Python", "MCP")]: async (input: RuntimeResourceConfig) => {
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
    const isContainer = input.scaffoldRuntimeInput.build === "Container";
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/python-mcp" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name) => {
          if (name === "Dockerfile" || name === ".dockerignore") return isContainer;
          return true;
        },
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
    const context = {
      name: toPythonPackageName(input.name),
      modelProvider: input.scaffoldRuntimeInput.modelProvider,
      hasMemory: memory !== undefined,
      // the CDK injects this env var corresponding to the actual ID once its resolved on deployment.
      memoryEnvVarName: memory ? `MEMORY_${memory.name.toUpperCase()}_ID` : undefined,
      memoryStrategies: memory?.strategies.map(({ type }) => type) ?? [],
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
    const isContainer = input.scaffoldRuntimeInput.build === "Container";
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/strands-py-a2a" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => {
          if (isDir && name === "memory") return memory !== undefined;
          if (name === "Dockerfile" || name === ".dockerignore") return isContainer;
          return true;
        },
      },
    );
    return {
      tree,
      spec: {
        runtimes: [{ ...buildRuntimeSpec(input), protocol: "A2A" as const }],
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
  // An imported Bedrock Agent always scaffolds the proxy template, regardless
  // of the framework/language key.
  if (input.importBedrockAgent) {
    return { resolve: importBedrockAgentResolver(config.assetSource, config.templateRenderer) };
  }

  const { framework, language, protocol } = input.scaffoldRuntimeInput;
  const key = buildResolverKey(framework, language, protocol);

  const resolve = getTemplateResolvers(config.assetSource, config.templateRenderer)[key];
  if (!resolve) return undefined;
  return { resolve };
}
