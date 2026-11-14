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
import { boxGatewayEntryForRuntime } from "../../../handlers/project/shortcuts";
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
  options?: {
    runtime?: ScaffoldRuntimeInput;
    importBedrockAgent?: ImportBedrockAgentInput;
    /** The region the command resolved; it picks the Bedrock endpoint of the Box gateway entry. */
    region?: string;
  },
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
  const boxGatewayEntry =
    options?.runtime && boxGatewayEntryForRuntime(options.runtime, options.region);

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
            // The entry that adds the runtime's model target to its Box gateway. It sits in
            // agentCoreGateways, not in the template's runtime files.
            ...(boxGatewayEntry ? [{ agentCoreGateways: [boxGatewayEntry] }] : []),
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

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
