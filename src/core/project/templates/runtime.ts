import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { RuntimeResourceConfig } from "../../../handlers/project/add/runtime/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { TemplateRenderer, TemplateResolver } from "./types";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import { InputValidationError } from "../../../errors";

function buildRuntimeSpec(input: RuntimeResourceConfig): ProjectRuntime {
  const { scaffoldRuntimeInput, name, ...infra } = input;
  return {
    name,
    build: scaffoldRuntimeInput.build,
    entrypoint: scaffoldRuntimeInput.entrypoint,
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
 * Normalize a name for use as a Python package name per PEP 508.
 * Valid names consist only of ASCII letters, numbers, period, underscore, and
 * hyphen, and must start and end with a letter or number.
 */
function toPythonPackageName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "");
}

function buildResolverKey(
  framework: ScaffoldRuntimeInput["framework"],
  language: ScaffoldRuntimeInput["language"],
): `${ScaffoldRuntimeInput["framework"]}/${ScaffoldRuntimeInput["language"]}` {
  return `${framework}/${language}`;
}

const getTemplateResolvers = (assetSource: AssetSource, templateRenderer: TemplateRenderer) => ({
  [buildResolverKey("none", "Python")]: async (input: RuntimeResourceConfig) => {
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError(`hello-world-python only supports HTTP protocol`);
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
  [buildResolverKey("strands", "Python")]: async (input: RuntimeResourceConfig) => {
    if (input.protocol !== undefined && input.protocol !== "HTTP")
      throw new InputValidationError("the strands-python template only supports HTTP");

    if (input.scaffoldRuntimeInput.build !== "CodeZip")
      throw new InputValidationError("the strands template only supports CodeZip builds");

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
    };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource },
      { assetDir: "templates/strands-http-python" },
      {
        rootDirName: input.name,
        transformContent: (raw) => templateRenderer.render(raw, context),
        filter: (name, isDir) => memory !== undefined || !isDir || name !== "memory",
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
  const { framework, language } = input.scaffoldRuntimeInput;
  const key = buildResolverKey(framework, language);

  const resolve = getTemplateResolvers(config.assetSource, config.templateRenderer)[key];
  if (!resolve) return undefined;
  return { resolve };
}
