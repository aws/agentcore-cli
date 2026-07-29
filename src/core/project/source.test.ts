import { describe, expect, test } from "bun:test";
import { embeddedSource } from "./source";

describe("embeddedSource", () => {
  test("throws when the asset is not embedded", () => {
    expect(embeddedSource.read("cdk/package.json")).rejects.toThrow(/Embedded asset not found/);
  });
});
