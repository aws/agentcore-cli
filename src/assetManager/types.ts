export const ASSET_NAMES = ["cdk"] as const;

export type AssetName = (typeof ASSET_NAMES)[number];

export type AssetVariables = Record<string, unknown>;

/**
 * A single asset resolved to its position within an asset tree, ready to
 * render. `relativePath` is relative to the asset root (e.g. `bin/cdk.ts`),
 * regardless of whether the bytes came from disk or an embedded blob.
 */
export interface AssetFile {
  relativePath: string;
  text(): Promise<string>;
}

/**
 * A raw file embedded in the compiled binary, as exposed by `Bun.embeddedFiles`.
 * `name` is the full build-time virtual path (e.g.
 * `agentcore-assets/src/assets/cdk/bin/cdk.ts`), which the manager strips down
 * to an `AssetFile.relativePath`.
 */
export interface EmbeddedFile {
  readonly name: string;
  text(): Promise<string>;
}
