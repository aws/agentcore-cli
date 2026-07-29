import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../fs";

/**
 * A node in a project's file tree where directories nest and files are leaves.
 * File bytes come from a thunk so the tree never knows where the bytes originate.
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

/** Thrown when scaffolding would overwrite a file that already exists. */
export class ProjectFileExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Refusing to overwrite existing file: ${path}`);
    this.name = "ProjectFileExistsError";
  }
}

/**
 * Writes a project tree to the destination with atomic file writes.
 * Refuses to overwrite an existing file so a re-run fails loudly instead of clobbering user work.
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
    throw new ProjectFileExistsError(path);
  }
  await atomicWrite(path, await node.bytes());
}
