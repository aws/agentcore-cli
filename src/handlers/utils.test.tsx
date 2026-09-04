import { describe, expect, test } from "bun:test";
import { parseJsonArrayFlag, parseJsonObjectFlag, parseTags, withRegion } from "./utils";

describe("structured JSON flags", () => {
  test("parses object and array values", () => {
    expect(parseJsonObjectFlag("config", '{"enabled":true}')).toEqual({ enabled: true });
    expect(parseJsonArrayFlag("items", '[{"id":"a"}]')).toEqual([{ id: "a" }]);
  });

  test("rejects the wrong top-level shape", () => {
    expect(() => parseJsonObjectFlag("config", "[]")).toThrow("must be a JSON object");
    expect(() => parseJsonObjectFlag("config", "null")).toThrow("must be a JSON object");
    expect(() => parseJsonArrayFlag("items", "{}")).toThrow("must be a JSON array");
  });
});

describe("parseTags", () => {
  test("returns undefined for undefined input", () => {
    expect(parseTags(undefined)).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(parseTags([])).toBeUndefined();
  });

  test("parses a single key=value pair", () => {
    expect(parseTags(["env=prod"])).toEqual({ env: "prod" });
  });

  test("parses multiple key=value pairs", () => {
    expect(parseTags(["env=prod", "team=agentcore"])).toEqual({
      env: "prod",
      team: "agentcore",
    });
  });

  test("handles values containing equals signs", () => {
    expect(parseTags(["config=a=b=c"])).toEqual({ config: "a=b=c" });
  });

  test("parses a JSON object", () => {
    expect(parseTags(['{"env":"prod","team":"agentcore"}'])).toEqual({
      env: "prod",
      team: "agentcore",
    });
  });

  test("rejects invalid JSON", () => {
    expect(() => parseTags(["{not json}"])).toThrow("Invalid JSON");
  });

  test("rejects JSON array (not an object)", () => {
    expect(() => parseTags(['["a","b"]'])).toThrow("expected key=value");
  });

  test("rejects JSON with non-string values", () => {
    expect(() => parseTags(['{"count":42}'])).toThrow("must be a string, got number");
  });

  test("rejects key=value without a key", () => {
    expect(() => parseTags(["=value"])).toThrow("expected key=value");
  });

  test("rejects bare value without equals", () => {
    expect(() => parseTags(["noequals"])).toThrow("expected key=value");
  });
});

describe("withRegion", () => {
  test("appends the region as a query string", () => {
    expect(withRegion("/agentcore/runtime/get/rt-1", "eu-west-1")).toBe(
      "/agentcore/runtime/get/rt-1?region=eu-west-1",
    );
  });

  test("joins an existing query string", () => {
    expect(withRegion("/agentcore/harness/exec/h-1?qualifier=PROD", "eu-west-1")).toBe(
      "/agentcore/harness/exec/h-1?qualifier=PROD&region=eu-west-1",
    );
  });

  test("keeps a region the route already names", () => {
    expect(withRegion("/agentcore/memory/get/m-1?region=us-west-2", "eu-west-1")).toBe(
      "/agentcore/memory/get/m-1?region=us-west-2",
    );
  });

  test("leaves the route alone without an override", () => {
    expect(withRegion("/agentcore/runtime/get/rt-1", null)).toBe("/agentcore/runtime/get/rt-1");
    expect(withRegion("/agentcore/runtime/get/rt-1", undefined)).toBe(
      "/agentcore/runtime/get/rt-1",
    );
    expect(withRegion("/agentcore/runtime/get/rt-1", "")).toBe("/agentcore/runtime/get/rt-1");
  });
});
