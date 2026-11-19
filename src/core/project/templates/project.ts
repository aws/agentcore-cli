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
import {
  BOX_CODEZIP_ENTRYPOINT,
  hasBoxProfile,
  isBoxedContainer,
  startsInBoxOnCodeZip,
} from "./boxProfile";
import { mergeSpecEntries } from "./spec";
import { boxGatewaySpec } from "../../../projectSchemas/project";
import type { SpecEntries, Template, TemplateRenderer } from "./types";
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
    // A runtime that gets a box profile runs its agent in a box, so its template is a Box template.
    // Until the box templates make Box projects opt-in, that is every Python CodeZip template and
    // the Strands container template.
    templates.push(
      hasBoxProfile(options.runtime)
        ? { ...template, spec: { ...template.spec, projectType: "box" } }
        : template,
    );
  }

  const envEntries = templates.flatMap((template) => template.envEntries ?? []);

  const tree = FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", () =>
      config.assetSource.read("templates/shared/gitignore.template"),
    ),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" }),
      FsTreeNode.createFile("agentcore.json", async () =>
        json(
          newProjectSpec(
            input.projectName,
            templates.map(({ spec }) => spec),
          ),
        ),
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
 * start.sh is kept as box-start.sh in the assets: the standalone binary embeds
 * each asset under its folder and stem, and start.py already has that stem.
 */
function withBoxStartScript(config: CreateProjectConfig, template: Template): void {
  const files = [
    [BOX_CODEZIP_ENTRYPOINT, BOX_CODEZIP_ENTRYPOINT],
    ["start.sh", "box-start.sh"],
  ] as const;
  for (const [name, asset] of files) {
    template.tree.children.push(
      FsTreeNode.createFile(name, () => config.assetSource.read(`templates/box-codezip/${asset}`)),
    );
  }
  for (const runtime of template.spec.runtimes ?? []) {
    runtime.entrypoint = BOX_CODEZIP_ENTRYPOINT;
    // The box release build and deploy ship; change it to move to another release. dev runs the
    // box on PATH.
    runtime.box = { version: BOX_RELEASE.version };
  }
}

/**
 * The container image's entry point, start.sh, which the Dockerfile copies
 * into /opt/box: it fills in the deployed resources and starts `box run`.
 * Dev, build and deploy stage box into .box-dist/, which the Dockerfile copies.
 */
function withBoxContainerStartScript(config: CreateProjectConfig, template: Template): void {
  template.tree.children.push(
    FsTreeNode.createFile("start.sh", () =>
      config.assetSource.read("templates/box-container/start.sh"),
    ),
  );
  // The box release that dev, build and deploy stage into the image; change it to move to another.
  for (const runtime of template.spec.runtimes ?? [])
    runtime.box = { version: BOX_RELEASE.version };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The agentcore.json of a new project, from the spec entries of its templates. Only a Box template
 * (one with `projectType: "box"`) makes a Box project: it gets `projectType` and one Box gateway
 * for each runtime. No other command adds `projectType`.
 */
export function newProjectSpec(projectName: string, entries: SpecEntries[]) {
  const { projectType, ...merged } = mergeSpecEntries(entries);
  const boxGateways =
    projectType === "box" ? (merged.runtimes ?? []).map(({ name }) => boxGatewaySpec(name)) : [];
  return {
    name: projectName,
    version: 2,
    managedBy: "CDK",
    ...(projectType && { projectType }),
    ...merged,
    ...(boxGateways.length > 0 && { agentCoreGateways: boxGateways }),
  };
}
