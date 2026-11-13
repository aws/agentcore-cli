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
          // A Box project: the CDK library adds the Box gateway, and the entry adds targets to it.
          ...(options?.runtime?.boxGateway && { projectType: "box" }),
          ...mergeSpecEntries([
            ...templates.map(({ spec }) => spec),
            // The Box gateway entry belongs to the project, not to one template's files.
            ...(options?.runtime?.boxGateway
              ? [{ agentCoreGateways: [options.runtime.boxGateway] }]
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
 */
function withBoxContainerStartScript(config: CreateProjectConfig, template: Template): void {
  template.tree.children.push(
    FsTreeNode.createFile("start.sh", () =>
      config.assetSource.read("templates/box-container/start.sh"),
    ),
  );
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
