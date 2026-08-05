import type { DirNode, ProjectNode } from "./tree";
import { dir, file } from "./tree";
import type { AssetSource } from "./source";
import { TEMPLATES } from "./templates";
import type { ProjectTemplate } from "../../handlers/project/types";

/** Serializes a value as pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Expands the flat asset listing under assetDir into a nested tree of nodes.
 * Ignore templates are renamed to dotfiles because npm strips real dotfiles when publishing.
 */
async function expandDir(src: AssetSource, assetDir: string): Promise<ProjectNode[]> {
  const paths = await src.list(assetDir);
  const root: ProjectNode[] = [];

  for (const assetPath of paths) {
    const relative = assetPath.slice(assetDir.length + 1);
    const segments = relative.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`Unsafe asset path: ${assetPath}`);
    }

    let cursor = root;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        cursor.push(file(renderName(segment), () => src.read(assetPath)));
        return;
      }
      let child = cursor.find((n): n is DirNode => n.kind === "dir" && n.name === segment);
      if (!child) {
        child = dir(segment, []);
        cursor.push(child);
      }
      cursor = child.children;
    });
  }

  return root;
}

function renderName(filename: string): string {
  const ignore = filename.match(/^(git|npm)ignore\.template$/);
  return ignore ? `.${ignore[1]}ignore` : filename;
}

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

/**
 * Composes the full project tree for a template rooted at the destination.
 * Config files live under agentcore/ because that is where the deploy tooling discovers a project.
 */
export async function projectTree(
  name: string,
  template: ProjectTemplate,
  src: AssetSource,
): Promise<ProjectNode> {
  const { appDir, assetDir } = TEMPLATES[template];
  return dir(".", [
    dir("agentcore", [
      dir("cdk", await expandDir(src, "cdk")),
      file(".gitignore", async () => ".build/\n.cache/\n.cli/\n"),
      file("agentcore.json", async () => json(agentcoreSpec(name, template))),
      file("aws-targets.json", async () => json([])),
    ]),
    dir("app", [dir(appDir, await expandDir(src, assetDir))]),
  ]);
}
