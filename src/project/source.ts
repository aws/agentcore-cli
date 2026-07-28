import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Provides an interface for abstracting bun executable asset reading
 * and Node asset reading
 */
export interface Source {
  /** Returns a thunk that reads the text of the asset at `assetPath`. */
  read(assetPath: string): () => Promise<string>;
  /** Lists asset paths of every file under `assetDir`, sorted, recursively. */
  list(assetDir: string): Promise<string[]>;
}

// Embedded assets are keyed by the build-time virtual path (see scripts/build.ts ASSET_NAMING)
const EMBEDDED_PREFIX = "agentcore-assets/src/assets/";

// A standalone executable exposes its assets through Bun.embeddedFiles as
// File blobs carrying their build-time name
type NamedBlob = Blob & { readonly name: string };

const embeddedBlobs = () => Bun.embeddedFiles as readonly NamedBlob[];

/** Reads assets from Bun.embeddedFiles — for the compiled standalone executable. */
export const embeddedSource: Source = {
  read(assetPath) {
    const name = `${EMBEDDED_PREFIX}${assetPath}`;
    return () => {
      const blob = embeddedBlobs().find((f) => f.name === name);
      if (!blob) {
        throw new Error(`Embedded asset not found: ${assetPath}`);
      }
      return blob.text();
    };
  },
  async list(assetDir) {
    const prefix = `${EMBEDDED_PREFIX}${assetDir}/`;
    return embeddedBlobs()
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => f.name.slice(EMBEDDED_PREFIX.length))
      .sort();
  },
};

/** Reads assets from src/assets/ on disk — for the Node/Bun runtime from source. */
export function fileSource(assetsRoot = resolveAssetsRoot()): Source {
  return {
    read: (assetPath) => () => readFile(join(assetsRoot, assetPath), "utf8"),
    async list(assetDir) {
      const root = join(assetsRoot, assetDir);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(assetDir, relative(root, join(entry.parentPath, entry.name))))
        .map((p) => p.replaceAll("\\", "/"))
        .sort();
    },
  };
}

// Bundled builds place assets/ beside the emitted module but source layout has it
// one level up from this module
function resolveAssetsRoot(moduleDirectory = dirname(fileURLToPath(import.meta.url))): string {
  const bundledRoot = resolve(moduleDirectory, "assets");
  if (existsSync(bundledRoot)) {
    return bundledRoot;
  }
  return resolve(moduleDirectory, "../assets");
}

/**
 * Selects the asset source for the current runtime: embedded assets when running
 * as a compiled Bun executable, disk otherwise.
 */
export function defaultSource(): Source {
  const embedded = typeof Bun !== "undefined" && Bun.embeddedFiles.length > 0;
  return embedded ? embeddedSource : fileSource();
}
