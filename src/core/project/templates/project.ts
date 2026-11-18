import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type {
  ImportBedrockAgentInput,
  RuntimeResourceConfig,
} from "../../../handlers/project/add/runtime/types";
import { InputValidationError } from "../../../errors/errors";
import { getRuntimeTemplateResolver } from "./runtime";
import { BOX_RELEASE } from "../backends/boxRelease";
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
  input: { projectName: string; secureVpc?: boolean },
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
    if (isBoxedContainer(options.runtime)) withBoxContainerBoxVersion(template);
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
          ...(input.secureVpc && { secureVpc: "ENABLED", network: { mode: "CONTAINED" } }),
          ...mergeSpecEntries([
            ...templates.map(({ spec }) => spec),
            // The entry that adds the template's targets (a model endpoint) to the runtime's
            // Box gateway. It sits in agentCoreGateways, not in the template's runtime files.
            ...(options?.runtime?.boxGatewayEntry
              ? [{ agentCoreGateways: [options.runtime.boxGatewayEntry] }]
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
  // start.py is the Runtime's entry point: it sets HOME and a writable workspace, exports the
  // Python and code paths the box/agentcore-codezip pack reads, then execs `box run`. No start.sh.
  template.tree.children.push(
    FsTreeNode.createFile(BOX_CODEZIP_ENTRYPOINT, () =>
      config.assetSource.read(`templates/box-codezip/${BOX_CODEZIP_ENTRYPOINT}`),
    ),
  );
  for (const runtime of template.spec.runtimes ?? []) {
    runtime.entrypoint = BOX_CODEZIP_ENTRYPOINT;
    // The box release dev runs, and build and deploy ship; change it to move to another release.
    runtime.box = { version: BOX_RELEASE.version };
  }
}

/**
 * The box release a container image stages: build and deploy use `box.version` to download box in
 * the Dockerfile. The image runs `box run` directly and needs no start script.
 */
function withBoxContainerBoxVersion(template: Template): void {
  // The box release that build and deploy stage into the image; change it to move to another.
  for (const runtime of template.spec.runtimes ?? [])
    runtime.box = { version: BOX_RELEASE.version };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
