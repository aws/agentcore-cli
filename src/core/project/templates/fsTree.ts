import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetSource } from "../source";
import { AgentCoreCLIError, ERROR_SOURCE } from "../../../errors";
import { InputValidationError, ProjectStateError } from "../../../errors/errors";

/**
 * FsTreeNode represents a tree of directories and files.
 */
export class FsTreeNode {
  constructor(
    readonly name: string,
    readonly isDir: boolean,
    public children: FsTreeNode[] = [],
    public bytes?: () => Promise<string>,
  ) {}

  async walk(
    cb: (current: FsTreeNode, path: string) => Promise<boolean>,
    parentPath = "",
  ): Promise<boolean> {
    const path = join(parentPath, this.name);
    if (!(await cb(this, path))) {
      return false;
    }

    for (const child of this.children) {
      if (!(await child.walk(cb, path))) {
        return false;
      }
    }

    return true;
  }

  async write(dest: string): Promise<void> {
    await this.walk(async (node, path) => {
      if (node.isDir) {
        await mkdir(path, { recursive: true });
        return true;
      }

      if (existsSync(path)) {
        throw new ProjectStateError(`File already exists: ${path}`);
      }

      await writeFile(path, await node.bytes!());
      return true;
    }, dest);
  }

  static createFile(name: string, bytes: () => Promise<string>): FsTreeNode {
    return new FsTreeNode(name, false, [], bytes);
  }

  static createDirectory(name: string, children: FsTreeNode[]): FsTreeNode {
    return new FsTreeNode(name, true, children);
  }

  /**
   * A file node whose content is read from a local text file on disk at write time,
   */
  static fromTextFile(name: string, sourcePath: string): FsTreeNode {
    return FsTreeNode.createFile(name, async () => {
      if (!existsSync(sourcePath)) {
        throw new InputValidationError(`file not found: '${sourcePath}'`);
      }
      return readFile(sourcePath, "utf-8");
    });
  }

  /**
   * Expands the flat asset listing under assetDir into a nested tree of nodes.
   */
  static async fromAssetSource(
    src: AssetSource,
    assetDir: string,
    rootDirName?: string,
    transform?: (content: string) => string,
  ): Promise<FsTreeNode> {
    const paths = await src.list(assetDir);
    const root = FsTreeNode.createDirectory(rootDirName ?? assetDir, []);

    for (const assetPath of paths) {
      const relative = assetPath.slice(assetDir.length + 1);
      const segments = relative.split("/");
      if (segments.some((s) => s === "" || s === "." || s === "..")) {
        throw new AgentCoreCLIError(`Unsafe asset path: ${assetPath}`, {
          source: ERROR_SOURCE.USER,
        });
      }

      let parent = root;
      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          parent.children.push(
            FsTreeNode.createFile(renderName(segment), async () => {
              const raw = await src.read(assetPath);
              return transform ? transform(raw) : raw;
            }),
          );
          return;
        }

        let child = parent.children.find((n): n is FsTreeNode => n.isDir && n.name === segment);
        if (!child) {
          child = FsTreeNode.createDirectory(segment, []);
          parent.children.push(child);
        }

        parent = child;
      });
    }

    return root;
  }
}

/**
 * Render filenames according to the following rules:
 * - *ignore.template -> .*ignore to support `.` files.
 * - *.template -> * to support extensionless files.
 */
function renderName(filename: string): string {
  const ignoreMatchResult = filename.match(/^(git|npm|docker)ignore\.template$/);
  if (ignoreMatchResult) return `.${ignoreMatchResult[1]}ignore`;
  if (filename.endsWith(".template")) return filename.slice(0, -".template".length);
  return filename;
}
