import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "../source";
import type { ScaffoldRuntimeInput } from "../../../handlers/project/types";
import type { RuntimeResourceConfig } from "../../../handlers/project/add/runtime/types";
import { InputValidationError } from "../../../errors/errors";
import { getRuntimeTemplateResolver } from "./runtime";
import type { SpecEntries, Template, TemplateRenderer } from "./types";

type CreateProjectConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};
/** Scaffold a project from scratch, with optional support for rendering a runtime with the project. **/
export async function createProjectTree(
  config: CreateProjectConfig,
  input: { projectName: string },
  options?: { runtime?: ScaffoldRuntimeInput },
): Promise<FsTreeNode> {
  const templates: Template[] = [];
  if (options?.runtime) {
    const runtimeConfig: RuntimeResourceConfig = {
      name: options.runtime.runtimeName,
      scaffoldRuntimeInput: options.runtime,
    };

    const resolver = getRuntimeTemplateResolver(config, runtimeConfig);
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    templates.push(await resolver.resolve(runtimeConfig));
  }

  return FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", () =>
      config.assetSource.read("templates/shared/gitignore.template"),
    ),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" }),
      FsTreeNode.createFile("agentcore.json", async () =>
        json({
          name: input.projectName,
          version: 1,
          managedBy: "CDK",
          ...mergeSpecEntries(templates.map(({ spec }) => spec)),
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
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function mergeSpecEntries(entries: SpecEntries[]): SpecEntries {
  const runtimes = entries.flatMap(({ runtimes }) => runtimes ?? []);
  const credentials = entries.flatMap(({ credentials }) => credentials ?? []);
  const memories = entries.flatMap(({ memories }) => memories ?? []);
  const harnesses = entries.flatMap(({ harnesses }) => harnesses ?? []);

  return {
    ...(runtimes.length > 0 && { runtimes }),
    ...(credentials.length > 0 && { credentials }),
    ...(memories.length > 0 && { memories }),
    ...(harnesses.length > 0 && { harnesses }),
  };
}
