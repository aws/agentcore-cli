import { describe, expect, test } from "bun:test";
import { hasValue } from "./boxProfileEgress";

describe("hasValue", () => {
  test("is true only for a set, non-blank value", () => {
    expect(hasValue("k")).toBe(true);
    expect(hasValue(undefined)).toBe(false);
    expect(hasValue("")).toBe(false);
    expect(hasValue(" \t")).toBe(false);
  });
});
