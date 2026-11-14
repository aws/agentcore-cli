import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type {
  ImportBedrockAgentInput,
  RuntimeResourceConfig,
} from "../../../handlers/project/add/runtime/types";
import { InputValidationError } from "../../../errors/errors";
import { getRuntimeTemplateResolver } from "./runtime";
import { BOX_CODEZIP_ENTRYPOINT, isBoxedContainer, startsInBoxOnCodeZip } from "./boxProfile";
import { BOX_GITHUB_TOKEN_SECRET, BOX_GITHUB_TOKEN_SECRET_ID } from "../backends/boxRelease";
import { getBoxGatewayPolicyEngineSpec } from "../../../handlers/project/shortcuts";
import { mergeSpecEntries } from "./spec";
import type { Template, TemplateRenderer } from "./types";
import type { EnvLocalEntry } from "../../../handlers/project/types";

type CreateProjectConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};
/** Scaffold a project from scratch, with optional support for rendering a runtime with the project. **/
export async function createProjectTree(
  config: CreateProjectConfig,
  input: { projectName: string },
  options?: { runtime?: ScaffoldRuntimeInput; importBedrockAgent?: ImportBedrockAgentInput },
): Promise<{ tree: FsTreeNode; envEntries: EnvLocalEntry[] }> {
  const templates: Template[] = [];
  if (options?.runtime) {
    const runtimeConfig: RuntimeResourceConfig = {
      name: options.runtime.runtimeName,
      scaffoldRuntimeInput: options.runtime,
      importBedrockAgent: options.importBedrockAgent,
    };

    const resolver = getRuntimeTemplateResolver(config, runtimeConfig);
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    const template = await resolver.resolve(runtimeConfig);
    if (startsInBoxOnCodeZip(options.runtime)) withBoxStartScript(config, template);
    if (isBoxedContainer(options.runtime)) withBoxContainerStartScript(config, template);
    templates.push(template);
  }

  const envEntries = templates.flatMap((template) => template.envEntries ?? []);

  const tree = FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", () =>
      config.assetSource.read("templates/shared/gitignore.template"),
    ),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" }),
      FsTreeNode.createFile("agentcore.json", async () =>
        json({
          name: input.projectName,
          version: 2,
          managedBy: "CDK",
          // Only new projects are Box projects; no other command adds this field.
          projectType: "box",
          ...mergeSpecEntries([
            ...templates.map(({ spec }) => spec),
            // The entry that adds the template's targets (a model endpoint) to the runtime's
            // Box gateway. It sits in agentCoreGateways, not in the template's runtime files. The
            // entry attaches the gateway's own policy engine, so declare that engine too.
            ...(options?.runtime?.boxGatewayEntry
              ? [
                  {
                    agentCoreGateways: [options.runtime.boxGatewayEntry],
                    policyEngines: [getBoxGatewayPolicyEngineSpec(options.runtime.runtimeName)],
                  },
                ]
              : []),
          ]),
        }),
      ),
      FsTreeNode.createFile("aws-targets.json", async () => json([])),
      FsTreeNode.createFile(".env.local", () =>
        config.assetSource.read("templates/shared/env.local.template"),
      ),
    ]),
    FsTreeNode.createDirectory(
      "app",
      templates.map((t) => t.tree),
    ),
  ]);

  return { tree, envEntries };
}

/**
 * Starts the runtime's agent in a box on a CodeZip deploy: start.py, the
 * entry point, runs start.sh, which runs `box run` with what deploy stages.
 * Create alone writes them, because only create writes the box profiles.
 */
function withBoxStartScript(config: CreateProjectConfig, template: Template): void {
  for (const name of [BOX_CODEZIP_ENTRYPOINT, "start.sh"]) {
    template.tree.children.push(
      FsTreeNode.createFile(name, () => config.assetSource.read(`templates/box-codezip/${name}`)),
    );
  }
  for (const runtime of template.spec.runtimes ?? []) runtime.entrypoint = BOX_CODEZIP_ENTRYPOINT;
}

/**
 * The container image's entry point, start.sh, which the Dockerfile copies
 * into /opt/box: it fills in the deployed resources and starts `box run`.
 * The Dockerfile installs box from the box release at build time, so the
 * runtime declares the GitHub token that reads the release as a build
 * secret, which CodeBuild reads from Secrets Manager on deploy.
 */
function withBoxContainerStartScript(config: CreateProjectConfig, template: Template): void {
  template.tree.children.push(
    FsTreeNode.createFile("start.sh", () =>
      config.assetSource.read("templates/box-container/start.sh"),
    ),
  );
  for (const runtime of template.spec.runtimes ?? []) {
    runtime.dockerBuildSecrets = { [BOX_GITHUB_TOKEN_SECRET_ID]: BOX_GITHUB_TOKEN_SECRET };
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
