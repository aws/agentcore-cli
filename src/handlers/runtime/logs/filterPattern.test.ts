import { describe, expect, test } from "bun:test";
import { buildFilterPattern } from "./filterPattern";

describe("buildFilterPattern", () => {
  test("returns undefined when neither level nor query is set", () => {
    expect(buildFilterPattern({})).toBeUndefined();
  });

  test("maps each level to its uppercase token", () => {
    expect(buildFilterPattern({ level: "error" })).toBe("ERROR");
    expect(buildFilterPattern({ level: "warn" })).toBe("WARN");
    expect(buildFilterPattern({ level: "info" })).toBe("INFO");
    expect(buildFilterPattern({ level: "debug" })).toBe("DEBUG");
  });

  test("passes the query through as-is", () => {
    expect(buildFilterPattern({ query: '"timed out"' })).toBe('"timed out"');
  });

  test("combines level and query with a space (implicit AND)", () => {
    expect(buildFilterPattern({ level: "error", query: "database" })).toBe("ERROR database");
  });
});
