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
    if (isBoxedContainer(options.runtime)) withBoxContainerBoxVersion(template);
    // Only a box template (agent-python-strands-box or agent-python-strands-box-container) runs its
    // agent in a box, so only it makes a Box project.
    templates.push(
      hasBoxProfile(options.runtime)
        ? { ...template, spec: { ...template.spec, projectType: "box" } }
        : template,
    );
  }

  const envEntries = templates.flatMap((template) => template.envEntries ?? []);
  const boxProject = options?.runtime !== undefined && hasBoxProfile(options.runtime);

  const tree = FsTreeNode.createDirectory(".", [
    FsTreeNode.createFile(".gitignore", async () => {
      const shared = await config.assetSource.read("templates/shared/gitignore.template");
      return boxProject ? `${shared}${BOX_GITIGNORE}` : shared;
    }),
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
 * entry point, runs `box run` with what deploy stages. Create alone writes it,
 * because only create writes the box profiles.
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
