import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type {
  ImportBedrockAgentInput,
  RuntimeResourceConfig,
} from "../../../handlers/project/add/runtime/types";
import { InputValidationError } from "../../../errors/errors";
import { getRuntimeTemplateResolver } from "./runtime";
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

    templates.push(await resolver.resolve(runtimeConfig));
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
