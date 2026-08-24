import { ZodError, z } from "zod";
import { HarnessSpecSchema } from "../../projectSchemas/harness";
import { FsTreeNode } from "./fsTree";
import type { AssetSource } from "./source";
import { InputValidationError } from "../../errors/errors";
import {
  RUNTIME_TEMPLATE_SHORTCUTS,
  type ScaffoldRuntimeInput,
} from "../../handlers/project/types";

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
  /** Asset directory relative to the asset root, expanded into the app directory. */
  assetDir: string;
  /** Resource sections this template contributes to agentcore.json. */
  spec: TemplateSpec;
};

const TEMPLATES: Record<string, Template> = {
  [buildRuntimeTemplateKey(RUNTIME_TEMPLATE_SHORTCUTS["hello-world-python"])]: {
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
  [buildRuntimeTemplateKey(RUNTIME_TEMPLATE_SHORTCUTS["hello-world-python-container"])]: {
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

function buildRuntimeTemplateKey(input: ScaffoldRuntimeInput): string {
  return `runtime_${input.build}_${input.framework}_${input.language}_${input.memory}_${input.modelProvider}`;
}

function resolveTemplate(input: ScaffoldRuntimeInput): Template | undefined {
  return TEMPLATES[buildRuntimeTemplateKey(input)];
}

/** Serializes a value as pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Builds the agentcore.json spec by adding the template's resource sections to the shared base.
 * The base fields and template sections never overlap so this is a plain spread.
 */
function agentcoreSpec(name: string, template: Template): unknown {
  return {
    name,
    version: 1,
    managedBy: "CDK",
    ...template.spec,
  };
}

export async function createProjectTree(
  name: string,
  input: ScaffoldRuntimeInput,
  src: AssetSource,
): Promise<FsTreeNode> {
  const template = resolveTemplate(input);
  if (!template)
    throw new InputValidationError(`unable to find template that matches given parameters`);
  return FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", () => src.read("templates/shared/gitignore.template")),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource(src, "cdk"),
      FsTreeNode.createFile("agentcore.json", async () => json(agentcoreSpec(name, template))),
      FsTreeNode.createFile("aws-targets.json", async () => json([])),
      FsTreeNode.createFile(".env.local", () => src.read("templates/shared/env.local.template")),
    ]),
    FsTreeNode.createDirectory("app", [
      await FsTreeNode.fromAssetSource(src, template.assetDir, input.runtimeName),
    ]),
  ]);
}

const DEFAULT_HARNESS_SYSTEM_PROMPT = "You are a helpful assistant";

export async function createHarnessTreeFromSpec(
  spec: z.input<typeof HarnessSpecSchema>,
): Promise<FsTreeNode> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { systemPrompt, ...rest } = spec;
  // strip system prompt such that markdown file is source of truth.
  const parsed = parseHarnessSpec(rest);
  return FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile("harness.json", async () => json(parsed)),
    FsTreeNode.createFile(
      "system-prompt.md",
      async () => spec.systemPrompt ?? DEFAULT_HARNESS_SYSTEM_PROMPT,
    ),
  ]);
}

function parseHarnessSpec(spec: z.input<typeof HarnessSpecSchema>) {
  try {
    return HarnessSpecSchema.parse(spec);
  } catch (err) {
    if (err instanceof ZodError) throw new InputValidationError(z.prettifyError(err));
    throw err;
  }
}
