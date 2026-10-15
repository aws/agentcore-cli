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
import type { Template, TemplateRenderer } from "./types";
import type { EnvLocalEntry } from "../../../handlers/project/types";
import type { ManagedBy } from "../../../projectSchemas/project";

type CreateProjectConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};
/** Scaffold a project from scratch, with optional support for rendering a runtime with the project. **/
export async function createProjectTree(
  config: CreateProjectConfig,
  input: { projectName: string; managedBy?: ManagedBy },
  options?: { runtime?: ScaffoldRuntimeInput; importBedrockAgent?: ImportBedrockAgentInput },
): Promise<{ tree: FsTreeNode; envEntries: EnvLocalEntry[] }> {
  const managedBy = input.managedBy ?? "CDK";
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
    FsTreeNode.createFile(".gitignore", async () => {
      const shared = await config.assetSource.read("templates/shared/gitignore.template");
      return managedBy === "Terraform"
        ? `${shared}\n# Terraform local packages, working files, and state (commit the .tf source)\nagentcore/terraform/**/assets/\nagentcore/terraform/**/artifacts.json\nagentcore/terraform/**/deployment.auto.tfvars.json\nagentcore/terraform/**/.agentcore-target.json\n.agentcore-operation.lock\n.terraform/\n*.tfstate\n*.tfstate.*\n*.tfplan\ncrash.log\n`
        : shared;
    }),
    FsTreeNode.createDirectory("agentcore", [
      ...(managedBy === "CDK"
        ? [
            await FsTreeNode.fromAssetSource(
              { assetSource: config.assetSource },
              { assetDir: "cdk" },
            ),
          ]
        : []),
      FsTreeNode.createFile("agentcore.json", async () =>
        json({
          name: input.projectName,
          version: 2,
          managedBy,
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

  return { tree, envEntries };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
