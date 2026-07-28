import type { DirNode, ProjectNode } from "./tree";
import { dir, file } from "./tree";
import type { Source } from "./source";
import { TEMPLATES } from "./templates";
import type { ProjectTemplate } from "../handlers/project/types";

/** Serializes a value as pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Builds the child nodes for agentcore/cdk/ by expanding the listing under cdk/
 * into a nested tree. `gitignore.template`
 */
async function expandDir(src: Source, assetDir: string): Promise<ProjectNode[]> {
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
        cursor.push(file(renderName(segment), src.read(assetPath)));
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

// The fixed base every project shares (name/version/managedBy), with the
// template's resource sections spread on top. Sections are template-specific
// and never collide with the base, so this is a spread, not a merge.
function agentcoreSpec(name: string, template: ProjectTemplate): unknown {
  return {
    name,
    version: 1,
    managedBy: "CDK",
    ...TEMPLATES[template].spec,
  };
}

/** Composes the full project tree for a template rooted at the destination */
export async function projectTree(
  name: string,
  template: ProjectTemplate,
  src: Source,
): Promise<ProjectNode> {
  const { appDir, assetDir } = TEMPLATES[template];
  return dir(".", [
    dir("agentcore", [
      dir("cdk", await expandDir(src, "cdk")),
      file("aws-targets.json", async () => json([])),
    ]),
    file("agentcore.json", async () => json(agentcoreSpec(name, template))),
    dir("app", [dir(appDir, await expandDir(src, assetDir))]),
  ]);
}
