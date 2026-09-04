import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbeddedAssetNotFoundError } from "../../errors";

/**
 * Reads and lists asset files by path relative to the asset root.
 * This is the one place that knows whether assets come from disk or from the compiled executable.
 */
export interface AssetSource {
  /** Reads the text of the asset at assetPath. */
  read(assetPath: string): Promise<string>;
  /** Lists asset paths of every file under assetDir, sorted, recursively. */
  list(assetDir: string): Promise<string[]>;
}

// Prefix the build script gives every embedded asset name at compile time.
const EMBEDDED_PREFIX = "agentcore-assets/src/assets/";

// Embedded files carry a name property that Bun's types widen to Blob.
type NamedBlob = Blob & { readonly name: string };

/** Reads assets embedded in the compiled standalone executable. */
export class EmbeddedAssetSource implements AssetSource {
  private blobs(): readonly NamedBlob[] {
    // oxlint-disable-next-line no-restricted-globals
    return Bun.embeddedFiles as readonly NamedBlob[];
  }

  public async read(assetPath: string): Promise<string> {
    const name = `${EMBEDDED_PREFIX}${assetPath}`;
    const blob = this.blobs().find((f) => f.name === name);
    if (!blob) {
      throw new EmbeddedAssetNotFoundError(assetPath);
    }
    return blob.text();
  }

  public async list(assetDir: string): Promise<string[]> {
    const prefix = `${EMBEDDED_PREFIX}${assetDir}/`;
    return this.blobs()
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => f.name.slice(EMBEDDED_PREFIX.length))
      .sort();
  }
}

/** Reads assets from the assets directory on disk. */
export class FsAssetSource implements AssetSource {
  constructor(private readonly assetsRoot: string = resolveAssetsRoot()) {}

  public read(assetPath: string): Promise<string> {
    return readFile(join(this.assetsRoot, assetPath), "utf8");
  }

  public async list(assetDir: string): Promise<string[]> {
    const root = join(this.assetsRoot, assetDir);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(assetDir, relative(root, join(entry.parentPath, entry.name))))
      .map((p) => p.replaceAll("\\", "/"))
      .sort();
  }
}

// Bundled builds place assets beside the emitted module and the source layout keeps them two levels up.
function resolveAssetsRoot(moduleDirectory = dirname(fileURLToPath(import.meta.url))): string {
  const bundledRoot = resolve(moduleDirectory, "assets");
  if (existsSync(bundledRoot)) {
    return bundledRoot;
  }
  return resolve(moduleDirectory, "../../assets");
}

/**
 * Selects the asset source for the current runtime: embedded assets when running
 * as a compiled Bun executable, disk otherwise.
 */
export function defaultSource(): AssetSource {
  // oxlint-disable-next-line no-restricted-globals
  const embedded = typeof Bun !== "undefined" && Bun.embeddedFiles.length > 0;
  return embedded ? new EmbeddedAssetSource() : new FsAssetSource();
}
