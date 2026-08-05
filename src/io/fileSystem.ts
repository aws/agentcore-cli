import { access, lstat, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { atomicWrite } from "./atomicWrite";

export type FileKind = "directory" | "file" | "symbolic-link" | "other";

export type FileInfo = {
  kind: FileKind;
  mode: number;
};

export type DirectoryEntry = {
  name: string;
  kind: FileKind;
};

export interface LocalFileSystem {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileInfo>;
  lstat(path: string): Promise<FileInfo>;
  readDirectory(path: string): Promise<DirectoryEntry[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  readLink(path: string): Promise<string>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  writeAtomic(path: string, contents: string | Uint8Array): Promise<void>;
}

function fileInfo(value: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
}): FileInfo {
  const kind = value.isDirectory()
    ? "directory"
    : value.isFile()
      ? "file"
      : value.isSymbolicLink()
        ? "symbolic-link"
        : "other";
  return { kind, mode: value.mode };
}

export class NodeLocalFileSystem implements LocalFileSystem {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileInfo> {
    return fileInfo(await stat(path));
  }

  async lstat(path: string): Promise<FileInfo> {
    return fileInfo(await lstat(path));
  }

  async readDirectory(path: string): Promise<DirectoryEntry[]> {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symbolic-link"
            : "other",
    }));
  }

  readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  readLink(path: string): Promise<string> {
    return readlink(path);
  }

  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
    return atomicWrite(path, contents);
  }
}

export const localFileSystem: LocalFileSystem = new NodeLocalFileSystem();
