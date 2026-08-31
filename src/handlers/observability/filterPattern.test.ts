import { describe, expect, test } from "bun:test";
import { buildFilterPattern } from "./filterPattern";

describe("buildFilterPattern", () => {
  test("returns no pattern without filters", () => {
    expect(buildFilterPattern({})).toBeUndefined();
  });

  test("combines normalized level and query filters", () => {
    expect(buildFilterPattern({ level: "error", query: '"timed out"' })).toBe('ERROR "timed out"');
  });
});
