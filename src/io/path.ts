import { access, stat } from "node:fs/promises";

/** Filesystem facts needed to locate a project without owning project semantics. */
export interface PathInspector {
  exists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
}

export class NodePathInspector implements PathInspector {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}

export const nodePathInspector: PathInspector = new NodePathInspector();
