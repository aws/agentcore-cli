import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../fs";

/**
 * A node in a project's file tree.
 */
export type ProjectNode = DirNode | FileNode;

export interface DirNode {
  kind: "dir";
  name: string;
  children: ProjectNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  bytes: () => Promise<string>;
}

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
 * Write a project tree to `destination`. Directories are created recursively;
 * files are written atomically.
 */
export async function writeTree(node: ProjectNode, destination: string): Promise<void> {
  const path = join(destination, node.name);
  if (node.kind === "dir") {
    await mkdir(path, { recursive: true });
    for (const child of node.children) {
      await writeTree(child, path);
    }
    return;
  }

  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
  await atomicWrite(path, await node.bytes());
}
