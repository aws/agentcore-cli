import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { TemplateRenderer } from "./types";
import type { RuntimeDocsConfig } from "../../../handlers/project/add/runtime/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  NodeRuntimeSchema,
  PythonRuntimeSchema,
  type ProtocolMode,
} from "../../../projectSchemas/constants";
import { defaultMemoryName, memoryEnvVarName } from "../../../projectSchemas/memory";
import { credentialProviderNameEnvVarName } from "../../../projectSchemas/credential";
import { LATEST_NODE, LATEST_PYTHON } from "../runtimeBuild";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InputValidationError, ResourceNotFoundError } from "../../../errors";

/**
 * The discovery prefix @aws/agentcore-cdk gives a project gateway:
 * `AGENTCORE_GATEWAY_<NAME>`, the name upper-cased with every other character
 * turned into `_` (the L3's `discoveryPrefix` / `connectionEnvToken`).
 */
function gatewayEnvPrefix(gatewayName: string): string {
  return `AGENTCORE_GATEWAY_${gatewayName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The port each protocol's runtime contract listens on. */
const PROTOCOL_PORTS: Record<ProtocolMode, number> = {
  HTTP: 8080,
  MCP: 8000,
  A2A: 9000,
  AGUI: 8080,
};

/** `PYTHON_3_14` -> `3.14`, `NODE_22` -> `22`. */
function versionNumber(version: string): string {
  return version.split("_").slice(1).join(".");
}

/** `["18", "20", "22"]` -> `18, 20 and 22`. */
function listVersions(versions: string[]): string {
  return versions.length < 2
    ? versions.join("")
    : `${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}`;
}

/** The entrypoint agentcore.json records: TypeScript deploys the bundled main.js. */
export function docsRuntimeEntrypoint(language: RuntimeDocsConfig["language"]): string {
  return language === "TypeScript" ? "main.js" : "main.py";
}

/**
 * The README.md and AGENTS.md for a runtime the user writes themselves,
 * rendered for its language and protocol.
 */
export async function runtimeDocsTree(
  config: { assetSource: AssetSource; templateRenderer: TemplateRenderer; projectRoot: string },
  input: RuntimeDocsConfig,
): Promise<FsTreeNode> {
  const protocol = input.protocol ?? "HTTP";
  const context = {
    name: input.name,
    protocol,
    port: PROTOCOL_PORTS[protocol],
    entrypoint: docsRuntimeEntrypoint(input.language),
    contractPage: protocol.toLowerCase(),
    // Supported and starting versions, from the schema so the docs follow it.
    versions: {
      latestPython: versionNumber(LATEST_PYTHON),
      latestNode: versionNumber(LATEST_NODE),
      latestPythonRuntime: LATEST_PYTHON,
      latestNodeRuntime: LATEST_NODE,
      python: listVersions(PythonRuntimeSchema.options.map(versionNumber)),
      node: listVersions(NodeRuntimeSchema.options.map(versionNumber)),
    },
    // Worked examples of the discovery variable names, rendered from the same
    // rules the CDK app uses so the docs cannot drift from them.
    memoryExample: {
      name: defaultMemoryName(input.name),
      env: memoryEnvVarName(defaultMemoryName(input.name)),
    },
    gatewayExample: { name: "docs-gateway", env: `${gatewayEnvPrefix("docs-gateway")}_URL` },
    credentialExample: {
      name: "openai-key",
      env: credentialProviderNameEnvVarName("openai-key"),
    },
  };
  const tree = await FsTreeNode.fromAssetSource(
    { assetSource: config.assetSource },
    {
      assetDir: `templates/runtime-docs/${input.language === "TypeScript" ? "typescript" : "python"}`,
    },
    {
      rootDirName: input.name,
      transformContent: (raw) => config.templateRenderer.render(raw, context),
    },
  );
  if (input.dockerfile) {
    const dockerfile = input.buildContextPath
      ? resolve(config.projectRoot, input.buildContextPath, input.dockerfile)
      : input.dockerfile;
    if (!existsSync(dockerfile))
      throw new ResourceNotFoundError(`no dockerfile exists at ${dockerfile}`);
    // Without a build context the Dockerfile is copied into the resource directory;
    // a Dockerfile-specific ignore file, which Docker reads instead of .dockerignore,
    // goes with it under the copied name.
    if (!input.buildContextPath) {
      const copies: [string, string][] = [["Dockerfile", dockerfile]];
      if (existsSync(`${dockerfile}.dockerignore`)) {
        copies.push(["Dockerfile.dockerignore", `${dockerfile}.dockerignore`]);
      }
      for (const [name, source] of copies) {
        // The resource directory is written without overwriting, so a different file
        // already there would silently win over the one the user asked for.
        const existing = join(config.projectRoot, "app", input.name, name);
        if (existsSync(existing) && !readFileSync(existing).equals(readFileSync(source))) {
          throw new InputValidationError(
            `app/${input.name}/${name} already exists and differs from ${source}. Remove it, or ` +
              `use it by passing "dockerfile": "app/${input.name}/Dockerfile" in --build-config, ` +
              "then retry.",
          );
        }
        tree.children.push(FsTreeNode.fromTextFile(name, source));
      }
    }
  }
  return tree;
}

/**
 * The agentcore.json entry for a docs-only runtime, with starting values: a
 * CodeZip build on the latest runtime for the language. dev, build, and deploy
 * update build, runtimeVersion, and entrypoint from the code once it exists.
 * With containerUri, a Container build of that image; codeLocation and
 * entrypoint are schema-required placeholders that nothing reads.
 */
export function buildDocsRuntimeSpec(input: RuntimeDocsConfig): ProjectRuntime {
  const { name, language, ...infra } = input;
  return {
    name,
    codeLocation: `app/${name}` as ProjectRuntime["codeLocation"],
    build: input.build ?? (input.containerUri ? "Container" : "CodeZip"),
    ...(input.containerUri && { containerUri: input.containerUri }),
    ...(input.containerUri === undefined &&
      (input.build === undefined || input.build === "CodeZip") && {
        runtimeVersion: language === "TypeScript" ? LATEST_NODE : LATEST_PYTHON,
      }),
    ...(input.dockerfile && {
      dockerfile: input.buildContextPath ? input.dockerfile : "Dockerfile",
    }),
    ...(input.buildContextPath !== undefined && { buildContextPath: input.buildContextPath }),
    ...(input.customDockerBuildArgs !== undefined && {
      customDockerBuildArgs: input.customDockerBuildArgs,
    }),
    entrypoint: docsRuntimeEntrypoint(language),
    protocol: infra.protocol ?? "HTTP",
    ...(infra.description && { description: infra.description }),
    ...(infra.executionRoleArn && { executionRoleArn: infra.executionRoleArn }),
    ...(infra.additionalPolicies?.length && { additionalPolicies: infra.additionalPolicies }),
    ...(infra.envVars?.length && { envVars: infra.envVars }),
    ...(infra.networkMode && { networkMode: infra.networkMode }),
    ...(infra.networkConfig && { networkConfig: infra.networkConfig }),
    ...(infra.platformVersion && { platformVersion: infra.platformVersion }),
    ...(infra.authorizerType && { authorizerType: infra.authorizerType }),
    ...(infra.authorizerConfiguration && {
      authorizerConfiguration: infra.authorizerConfiguration,
    }),
    ...(infra.requestHeaderAllowlist && { requestHeaderAllowlist: infra.requestHeaderAllowlist }),
    ...(infra.lifecycleConfiguration && { lifecycleConfiguration: infra.lifecycleConfiguration }),
    ...(infra.resourceConfigurations && { resourceConfigurations: infra.resourceConfigurations }),
    ...(infra.hooksConfiguration && { hooksConfiguration: infra.hooksConfiguration }),
    ...(infra.filesystemConfigurations && {
      filesystemConfigurations: infra.filesystemConfigurations,
    }),
    ...(infra.tags && { tags: infra.tags }),
  };
}
