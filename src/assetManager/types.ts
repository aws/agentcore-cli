export const ASSET_NAMES = ["cdk"] as const;

export type AssetName = (typeof ASSET_NAMES)[number];

export type AssetVariables = Record<string, unknown>;
export interface AssetFile {
  relativePath: string;
  text(): Promise<string>;
}
export interface EmbeddedFile {
  readonly name: string;
  text(): Promise<string>;
}
