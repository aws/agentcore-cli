import { describe, expect, test } from "bun:test";
import { EmbeddedAssetSource } from "./source";

describe("EmbeddedAssetSource", () => {
  test("throws when the asset is not embedded", () => {
    expect(new EmbeddedAssetSource().read("cdk/package.json")).rejects.toThrow(
      /Embedded asset not found/,
    );
  });
});
