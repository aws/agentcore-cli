import { join } from "node:path";
import { ProjectFileExistsError } from "../../errors";
import type { LocalFileSystem } from "../../io";

/**
 * A node in a project's file tree where directories nest and files are leaves.
 * File bytes come from a thunk so the tree never knows where the bytes originate.
 */
export type ProjectNode = DirNode | FileNode;

export type DirNode = {
  kind: "dir";
  name: string;
  children: ProjectNode[];
};

export type FileNode = {
  kind: "file";
  name: string;
  bytes: () => Promise<string>;
};

export const dir = (name: string, children: ProjectNode[]): DirNode => ({
  kind: "dir",
  name,
  children,
});

export const file = (name: string, bytes: () => Promise<string>): FileNode => ({
  kind: "file",
  name,
  bytes,
});

/**
 * Writes a project tree to the destination with atomic file writes.
 * Refuses to overwrite an existing file so a re-run fails loudly instead of clobbering user work.
 */
export async function writeTree(
  fileSystem: LocalFileSystem,
  node: ProjectNode,
  destination: string,
): Promise<void> {
  const path = join(destination, node.name);
  if (node.kind === "dir") {
    await fileSystem.createDirectory(path);
    for (const child of node.children) {
      await writeTree(fileSystem, child, path);
    }
    return;
  }

  if (await fileSystem.exists(path)) {
    throw new ProjectFileExistsError(path);
  }
  await fileSystem.writeAtomic(path, await node.bytes());
}
