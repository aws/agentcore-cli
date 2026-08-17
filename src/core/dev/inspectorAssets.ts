import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { defaultSource, type AssetSource } from "../project/source";

/** A static file of the Agent Inspector SPA, ready to serve. */
export interface InspectorAsset {
  body: Uint8Array;
  contentType: string;
}

/** The SPA ships exactly these types today; anything else is served as plain text. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type InspectorAssetReader = (assetPath: string) => Promise<InspectorAsset | undefined>;

/**
 * Reads the prebuilt Agent Inspector SPA. Resolution order:
 * 1. AGENT_INSPECTOR_PATH — a local inspector build, for SPA development.
 * 2. The staged asset tree (embedded in compiled binaries, dist/assets in the
 *    npm bundle, src/assets after any build).
 * 3. node_modules/@aws/agent-inspector/dist-assets — running from source
 *    before the first build, when nothing has been staged yet.
 */
export class InspectorAssets {
  private readonly source: AssetSource;
  private readonly overrideDir: string | undefined;

  constructor(options: { source?: AssetSource; overrideDir?: string } = {}) {
    this.source = options.source ?? defaultSource();
    this.overrideDir = options.overrideDir ?? process.env.AGENT_INSPECTOR_PATH;
  }

  public read: InspectorAssetReader = async (assetPath) => {
    const relative = assetPath.replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => part === "..")) return undefined;
    const contentType = CONTENT_TYPES[extname(relative)] ?? "text/plain; charset=utf-8";

    if (this.overrideDir) {
      try {
        return { body: await readFile(join(this.overrideDir, relative)), contentType };
      } catch {
        return undefined;
      }
    }

    try {
      // Staged files carry a neutral `.asset` suffix (see scripts/build.ts).
      const text = await this.source.read(`agent-inspector/${relative}.asset`);
      return { body: new TextEncoder().encode(text), contentType };
    } catch {
      // Not staged (running from source before a build) — fall through.
    }

    const packaged = packagedAssetsDir();
    if (!packaged) return undefined;
    try {
      return { body: await readFile(join(packaged, relative)), contentType };
    } catch {
      return undefined;
    }
  };
}

function packagedAssetsDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("@aws/agent-inspector/package.json")), "dist-assets");
  } catch {
    return undefined;
  }
}
