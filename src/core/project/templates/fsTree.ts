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
   * Builds a file tree from assets under `input.assetDir`.
   *
   * @param config - Asset source configuration.
   * @param input - Asset directory to load.
   * @param options - Optional root name, lazy content transform, and descendant filter. Rejecting a directory omits its subtree.
   */
  static async fromAssetSource(
    config: { assetSource: AssetSource },
    input: { assetDir: string },
    options?: {
      rootDirName?: string;
      transformContent?: (content: string) => string;
      filter?: (name: string, isDir: boolean) => boolean;
    },
  ): Promise<FsTreeNode> {
    const { assetSource } = config;
    const { assetDir } = input;
    const rootDirName = options?.rootDirName;
    const transformContent = options?.transformContent;
    const filter = options?.filter;
    const paths = await assetSource.list(assetDir);
    const root = FsTreeNode.createDirectory(rootDirName ?? assetDir, []);

    assetPaths: for (const assetPath of paths) {
      const relative = assetPath.slice(assetDir.length + 1);
      const segments = relative.split("/");
      if (segments.some((s) => s === "" || s === "." || s === "..")) {
        throw new AgentCoreCLIError(`Unsafe asset path: ${assetPath}`, {
          source: ERROR_SOURCE.USER,
        });
      }

      let parent = root;
      for (const [index, segment] of segments.entries()) {
        const isDir = index < segments.length - 1;
        const name = isDir ? segment : renderName(segment);
        // if the segment of a path rejects, reject the rest of the path so we jump to top-loop via assetPaths label.
        if (filter && !filter(name, isDir)) continue assetPaths;

        if (!isDir) {
          parent.children.push(
            FsTreeNode.createFile(name, async () => {
              const raw = await assetSource.read(assetPath);
              return transformContent ? transformContent(raw) : raw;
            }),
          );
          continue;
        }

        let child = parent.children.find(
          (node): node is FsTreeNode => node.isDir && node.name === name,
        );
        if (!child) {
          child = FsTreeNode.createDirectory(name, []);
          parent.children.push(child);
        }
        parent = child;
      }
    }

    return root;
  }
}

/**
 * Template assets carry a `.template` suffix so their real names survive publishing:
 * npm strips leading dotfiles, and `bun build` appends a trailing dot to extensionless
 * embedded assets (a bare `Dockerfile` embeds as `Dockerfile.`). The suffix is stripped here.
 */
function renderName(filename: string): string {
  const ignore = filename.match(/^(git|npm|docker)ignore\.template$/);
  if (ignore) return `.${ignore[1]}ignore`;
  if (filename === "Dockerfile.template") return "Dockerfile";
  return filename;
}
