import { extname, join } from "node:path";
import { readOptionalBytes, resolvePackageFileDir } from "../../io/packagedAssets";
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

const textEncoder = new TextEncoder();

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
  private readonly cache = new Map<string, InspectorAsset>();

  constructor(options: { source?: AssetSource; overrideDir?: string } = {}) {
    this.source = options.source ?? defaultSource();
    this.overrideDir = options.overrideDir ?? process.env.AGENT_INSPECTOR_PATH;
  }

  public read = async (assetPath: string): Promise<InspectorAsset | undefined> => {
    const relative = assetPath.replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => part === "..")) return undefined;
    const contentType = CONTENT_TYPES[extname(relative)] ?? "text/plain; charset=utf-8";

    if (this.overrideDir) {
      // SPA development iterates on these files — never cache.
      const body = await readOptionalBytes(join(this.overrideDir, relative));
      return body ? { body, contentType } : undefined;
    }

    const cached = this.cache.get(relative);
    if (cached) return cached;

    try {
      // Staged files carry a neutral `.asset` suffix (see scripts/build.ts).
      const text = await this.source.read(`agent-inspector/${relative}.asset`);
      const asset = { body: textEncoder.encode(text), contentType };
      this.cache.set(relative, asset);
      return asset;
    } catch {
      // Not staged (running from source before a build) — fall through.
    }

    const packaged = resolvePackageFileDir("@aws/agent-inspector/package.json");
    if (!packaged) return undefined;
    const body = await readOptionalBytes(join(packaged, "dist-assets", relative));
    if (!body) return undefined;
    const asset = { body, contentType };
    this.cache.set(relative, asset);
    return asset;
  };
}
