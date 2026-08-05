import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbeddedAssetNotFoundError } from "../errors";
import type { LocalFileSystem } from "./fileSystem";
import { localFileSystem } from "./fileSystem";

const EMBEDDED_PREFIX = "agentcore-assets/src/assets/";

type NamedBlob = Blob & { readonly name: string };

export interface AssetSource {
  read(assetPath: string): Promise<string>;
  list(assetDir: string): Promise<string[]>;
}

/** Reads project assets embedded in the compiled standalone executable. */
export class EmbeddedAssetSource implements AssetSource {
  private blobs(): readonly NamedBlob[] {
    return Bun.embeddedFiles as readonly NamedBlob[];
  }

  async read(assetPath: string): Promise<string> {
    const name = `${EMBEDDED_PREFIX}${assetPath}`;
    const blob = this.blobs().find((file) => file.name === name);
    if (!blob) {
      throw new EmbeddedAssetNotFoundError(assetPath);
    }
    return blob.text();
  }

  async list(assetDir: string): Promise<string[]> {
    const prefix = `${EMBEDDED_PREFIX}${assetDir}/`;
    return this.blobs()
      .filter((file) => file.name.startsWith(prefix))
      .map((file) => file.name.slice(EMBEDDED_PREFIX.length))
      .sort();
  }
}

/** Reads project assets from the source or bundled assets directory. */
export class FsAssetSource implements AssetSource {
  private assetsRoot?: Promise<string>;

  constructor(
    private readonly fileSystem: LocalFileSystem,
    private readonly configuredRoot?: string,
    private readonly moduleDirectory = dirname(fileURLToPath(import.meta.url)),
  ) {}

  async read(assetPath: string): Promise<string> {
    return this.fileSystem.readText(join(await this.root(), assetPath));
  }

  async list(assetDir: string): Promise<string[]> {
    const assetsRoot = await this.root();
    const root = join(assetsRoot, assetDir);
    const paths = await this.listFiles(root);
    return paths.map((path) => join(assetDir, relative(root, path)).replaceAll("\\", "/")).sort();
  }

  private async root(): Promise<string> {
    this.assetsRoot ??= this.resolveRoot();
    return this.assetsRoot;
  }

  private async resolveRoot(): Promise<string> {
    if (this.configuredRoot) {
      return this.configuredRoot;
    }
    const bundledRoot = resolve(this.moduleDirectory, "assets");
    return (await this.fileSystem.exists(bundledRoot))
      ? bundledRoot
      : resolve(this.moduleDirectory, "../assets");
  }

  private async listFiles(directory: string): Promise<string[]> {
    const paths: string[] = [];
    const entries = await this.fileSystem.readDirectory(directory);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.kind === "directory") {
        paths.push(...(await this.listFiles(path)));
      } else if (entry.kind === "file") {
        paths.push(path);
      }
    }
    return paths;
  }
}

export function defaultAssetSource(fileSystem: LocalFileSystem = localFileSystem): AssetSource {
  const embedded = typeof Bun !== "undefined" && Bun.embeddedFiles.length > 0;
  return embedded ? new EmbeddedAssetSource() : new FsAssetSource(fileSystem);
}
