import { describe, expect, test } from "bun:test";
import { EmbeddedAssetNotFoundError } from "../errors";
import { EmbeddedAssetSource } from "./assets";

describe("EmbeddedAssetSource", () => {
  test("throws a modeled error when the asset is not embedded", () => {
    expect(new EmbeddedAssetSource().read("cdk/package.json")).rejects.toBeInstanceOf(
      EmbeddedAssetNotFoundError,
    );
  });
});
