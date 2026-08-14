import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../handlers/project/types";
import { HarnessSpecSchema, type HarnessSpec } from "../../projectSchemas/harness";
import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "./source";

type TemplateSpec = {
  runtimes?: unknown[];
  memories?: unknown[];
  harnesses?: unknown[];
};

/**
 * A project template pairs the agent code scaffolded under app/ with the resource
 * sections it registers in agentcore.json. Adding a template is one entry here plus its assets.
 */
type Template = {
  /** Directory under app/ the template code is written to. */
  appDir: string;
  /** Asset directory relative to the asset root, expanded into the app directory. */
  assetDir: string;
  /** Resource sections this template contributes to agentcore.json. */
  spec: TemplateSpec;
};

export const TEMPLATES: Record<ProjectTemplate, Template> = {
  [PROJECT_TEMPLATES.HELLO_WORLD_PYTHON]: {
    appDir: "hello-world",
    assetDir: "templates/hello-world-python",
    spec: {
      runtimes: [
        {
          name: "hello_world",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/hello-world",
          // Required for CodeZip builds: the CDK construct library rejects a
          // CodeZip runtime with no runtimeVersion, and it is what selects the
          // packager. Container builds take their version from the image.
          runtimeVersion: "PYTHON_3_14",
        },
      ],
    },
  },
  [PROJECT_TEMPLATES.HELLO_WORLD_PYTHON_CONTAINER]: {
    appDir: "hello-world",
    assetDir: "templates/hello-world-python-container",
    spec: {
      runtimes: [
        {
          name: "hello_world",
          build: "Container",
          entrypoint: "main.py",
          codeLocation: "app/hello-world",
          dockerfile: "Dockerfile",
        },
      ],
    },
  },
};

/** Serializes a value as pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Builds the agentcore.json spec by adding the template's resource sections to the shared base.
 * The base fields and template sections never overlap so this is a plain spread.
 */
function agentcoreSpec(name: string, template: ProjectTemplate): unknown {
  return {
    name,
    version: 1,
    managedBy: "CDK",
    ...TEMPLATES[template].spec,
  };
}

export async function createProjectTreeFromTemplate(
  name: string,
  template: ProjectTemplate,
  src: AssetSource,
): Promise<FsTreeNode> {
  const { appDir, assetDir } = TEMPLATES[template];
  return FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", () => src.read("templates/shared/gitignore.template")),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource(src, "cdk"),
      FsTreeNode.createFile("agentcore.json", async () => json(agentcoreSpec(name, template))),
      FsTreeNode.createFile("aws-targets.json", async () => json([])),
      FsTreeNode.createFile(".env.local", () => src.read("templates/shared/env.local.template")),
    ]),
    FsTreeNode.createDirectory("app", [await FsTreeNode.fromAssetSource(src, assetDir, appDir)]),
  ]);
}

const DEFAULT_HARNESS_SYSTEM_PROMPT = "You are a helpful assistant";

export async function createHarnessTreeFromSpec(spec: HarnessSpec): Promise<FsTreeNode> {
  return FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile("harness.json", async () => json(HarnessSpecSchema.parse(spec))),
    FsTreeNode.createFile(
      "system-prompt.md",
      async () => spec.systemPrompt ?? DEFAULT_HARNESS_SYSTEM_PROMPT,
    ),
  ]);
}
