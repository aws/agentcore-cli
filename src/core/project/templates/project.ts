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
import { BOX_GATEWAY_TARGETS_NAME } from "../boxGatewayTargets";
import {
  BOX_CODEZIP_ENTRYPOINT,
  hasBoxProfile,
  isBoxedContainer,
  startsInBoxOnCodeZip,
} from "./boxProfile";
import { mergeSpecEntries } from "./spec";
import { BOX_TEMPLATE_TAG_VALUE, boxGatewaySpec } from "../../../projectSchemas/project";
import { TEMPLATE_TAG_KEY } from "../../../projectSchemas/tags";
import { BOX_PLATFORM_VERSION, DEFAULT_MODEL_IDS } from "../../../projectSchemas/runtime";
import type { SpecEntries, Template, TemplateRenderer } from "./types";
import type { EnvLocalEntry } from "../../../handlers/project/types";

type CreateProjectConfig = {
  assetSource: AssetSource;
  templateRenderer: TemplateRenderer;
};
/** Scaffold a project from scratch, with optional support for rendering a runtime with the project. **/
export async function createProjectTree(
  config: CreateProjectConfig,
  input: { projectName: string; privateVpc?: boolean },
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
    if (input.privateVpc && hasBoxProfile(options.runtime)) {
      for (const runtime of template.spec.runtimes ?? []) {
        runtime.containment = "PRIVATE_VPC";
        runtime.network = { mode: "CONTAINED" };
      }
    }
    // Box runs only on AgentCore Runtime V2, so a box runtime pins it.
    if (hasBoxProfile(options.runtime)) {
      for (const runtime of template.spec.runtimes ?? []) {
        runtime.platformVersion = BOX_PLATFORM_VERSION;
        recordBoxModelId(runtime, options.runtime);
      }
    }
    // Only a box template (a `-box` template in the shortcut table) runs its agent in a box, so
    // only it makes a Box project.
    templates.push(
      hasBoxProfile(options.runtime)
        ? { ...template, spec: { ...template.spec, projectType: "box" } }
        : template,
    );
  }

  const envEntries = templates.flatMap((template) => template.envEntries ?? []);
  const boxProject = options?.runtime !== undefined && hasBoxProfile(options.runtime);

  const spec = newProjectSpec(
    input.projectName,
    templates.map(({ spec }) => spec),
  );
  // Build owns no target of a new Box gateway yet: an empty entry in the record says so.
  const boxGateways = (spec.agentCoreGateways ?? []).flatMap(({ name, boundRuntime }) =>
    boundRuntime === undefined ? [] : [name],
  );
  const tree = FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", async () => {
      const shared = await config.assetSource.read("templates/shared/gitignore.template");
      return boxProject ? `${shared}${BOX_GITIGNORE}` : shared;
    }),
    FsTreeNode.createDirectory("agentcore", [
      await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" }),
      // The record comes first: a failed write of either file leaves no project with one alone.
      ...(boxGateways.length > 0
        ? [
            FsTreeNode.createFile(BOX_GATEWAY_TARGETS_NAME, async () =>
              json(Object.fromEntries(boxGateways.map((name) => [name, []]))),
            ),
          ]
        : []),
      FsTreeNode.createFile("agentcore.json", async () => json(spec)),
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
 * The files a CodeZip box runtime's folder needs, which create and add runtime write:
 * - start.py, the Runtime's entry point: it sets HOME and a writable workspace, exports the Python
 *   and code paths the @box/agentcore-codezip pack reads, then execs `box run`. No start.sh.
 * - an empty `.venv`. The box profile keeps the venv out of the write grant with an optional
 *   deny_write, which box drops while `.venv` is missing, and box then refuses the profile, as the
 *   venv's Python would be writable. `uv sync` fills the empty folder.
 */
export function boxCodeZipFiles(assetSource: AssetSource): FsTreeNode[] {
  return [
    FsTreeNode.createFile(BOX_CODEZIP_ENTRYPOINT, () =>
      assetSource.read(`templates/box-codezip/${BOX_CODEZIP_ENTRYPOINT}`),
    ),
    FsTreeNode.createDirectory(".venv", []),
  ];
}

/** Starts the runtime's agent in a box on a CodeZip deploy, with {@link boxCodeZipFiles}. */
function withBoxStartScript(config: CreateProjectConfig, template: Template): void {
  template.tree.children.push(...boxCodeZipFiles(config.assetSource));
  for (const runtime of template.spec.runtimes ?? []) {
    runtime.entrypoint = BOX_CODEZIP_ENTRYPOINT;
    // The box release build and deploy ship; change it to move to another release. dev runs the
    // box on PATH.
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

/**
 * Records in a box runtime that calls a Bedrock model the model ID its code renders (the template
 * default, or the scaffold input's modelId), so build lets its Box gateway call only that model. A runtime with no
 * model provider, such as the minimal template, calls no model and gets none.
 */
function recordBoxModelId(
  runtime: { modelProvider?: string; modelId?: string },
  input: Pick<ScaffoldRuntimeInput, "modelId" | "modelProvider">,
): void {
  if (runtime.modelId !== undefined || runtime.modelProvider !== "Bedrock") return;
  runtime.modelId = input.modelId ?? DEFAULT_MODEL_IDS.Bedrock;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The lines a Box project adds to its .gitignore, for every runtime it has or gets later: the
 * Runtime profile build renders into `.box/<agent>/aws/`, and the box release build and dev stage
 * into `.box-dist/` and `.box-dev/`. `.box/<agent>/local/` is the user's, and is committed.
 */
const BOX_GITIGNORE =
  "\n# Box (written by agentcore build, deploy and dev; .box/<agent>/local is committed)\n" +
  ".box/*/aws/\n" +
  ".box-dist/\n" +
  ".box-dev/\n";

/**
 * The agentcore.json of a new project, from the spec entries of its templates. Only a Box template
 * (one with `projectType: "box"`) makes a Box project: it gets `projectType` and one Box gateway
 * for each runtime. No other command adds `projectType`.
 */
export function newProjectSpec(projectName: string, entries: SpecEntries[]) {
  const { projectType, ...merged } = mergeSpecEntries(entries);
  const boxGateways =
    projectType === "box"
      ? // Each Box gateway takes the template tag of its runtime: the name of its Box template, or
        // strands-box for a runtime no template made.
        (merged.runtimes ?? []).map(({ name, tags }) =>
          boxGatewaySpec(name, tags?.[TEMPLATE_TAG_KEY] ?? BOX_TEMPLATE_TAG_VALUE),
        )
      : [];
  return {
    name: projectName,
    version: 2,
    managedBy: "CDK",
    ...(projectType && { projectType }),
    ...merged,
    ...(boxGateways.length > 0 && { agentCoreGateways: boxGateways }),
  };
}
