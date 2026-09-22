import { describe, expect, test } from "bun:test";
import z from "zod";
import {
  assertMutuallyExclusiveFlags,
  parseJsonArrayFlag,
  parseJsonFlagWithSchema,
  parseJsonObjectFlag,
  parseTags,
} from "./utils";

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

describe("parseJsonFlagWithSchema", () => {
  const ModelSchema = z
    .object({ modelId: z.string(), apiKeyArn: z.string().optional() })
    .refine((m) => m.modelId !== "needs-key" || m.apiKeyArn !== undefined, {
      message: "apiKeyArn is required",
    });

  test("returns undefined when the flag is omitted", () => {
    expect(parseJsonFlagWithSchema("model", undefined, ModelSchema)).toBeUndefined();
  });

  test("returns valid input unchanged", () => {
    expect(parseJsonFlagWithSchema("model", '{"modelId":"anthropic.x"}', ModelSchema)).toEqual({
      modelId: "anthropic.x",
    });
  });

  // The F17 case: without the strict pass this parses, drops `modlId`, and sends
  // an object missing the field the user was trying to set.
  test("rejects a key the schema does not declare instead of dropping it", () => {
    expect(() =>
      parseJsonFlagWithSchema("model", '{"modelId":"anthropic.x","modlId":"typo"}', ModelSchema),
    ).toThrow("model");
  });

  test("keeps the schema's own refinements", () => {
    expect(() => parseJsonFlagWithSchema("model", '{"modelId":"needs-key"}', ModelSchema)).toThrow(
      "apiKeyArn is required",
    );
  });

  // A record accepts any key by definition, so there is nothing to reject and the
  // strict pass must leave it alone.
  test("leaves a record schema permissive", () => {
    const tags = parseJsonFlagWithSchema(
      "tags",
      '{"env":"prod"}',
      z.record(z.string(), z.string()),
    );
    expect(tags).toEqual({ env: "prod" });
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

describe("assertMutuallyExclusiveFlags", () => {
  test.each([
    ["nothing set", ["a", "b"], {}, {}],
    ["a single flag set", ["a", "b"], { a: "x" }, {}],
    ["a false boolean flag alongside one set", ["a", "c"], { a: "x", c: false }, {}],
    ["a single flag set with exactlyOne", ["a", "b"], { a: "x" }, { exactlyOne: true }],
  ] as const)("permits %s", (_label, names, flags, options) => {
    expect(() => assertMutuallyExclusiveFlags(flags, names, options)).not.toThrow();
  });

  test.each([
    ["two flags set", ["a", "b"], { a: "x", b: "y" }, {}, "--a, --b are mutually exclusive"],
    [
      "a true boolean flag alongside one set",
      ["a", "c"],
      { a: "x", c: true },
      {},
      "--a, --c are mutually exclusive",
    ],
    [
      "only the set flags listed",
      ["a", "b", "c"],
      { a: "x", c: "z" },
      {},
      "--a, --c are mutually exclusive",
    ],
    [
      "nothing set with exactlyOne",
      ["a", "b"],
      {},
      { exactlyOne: true },
      "specify exactly one of --a, --b",
    ],
    [
      "many set with exactlyOne",
      ["a", "b", "c"],
      { a: "x", b: "y" },
      { exactlyOne: true },
      "specify exactly one of --a, --b, --c",
    ],
  ] as const)("rejects %s", (_label, names, flags, options, message) => {
    expect(() => assertMutuallyExclusiveFlags(flags, names, options)).toThrow(message);
  });
});
