import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../projectSchemas/project";
import { ProjectKey, ValueContext } from "../router";
import { TestCoreClient } from "../testing";
import { RegionKey } from "./keys";
import type { ProjectManager, ResolveDeployedResourceInput } from "./project/types";
import {
  assertMutuallyExclusiveFlags,
  parseJsonArrayFlag,
  parseJsonObjectFlag,
  parseTags,
  resolveResource,
  tagsFlag,
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

describe("parseTags", () => {
  test.each([
    ["undefined input", undefined, undefined],
    ["an empty array", [], undefined],
    ["one key=value pair", ["env=prod"], { env: "prod" }],
    [
      "multiple key=value pairs",
      ["env=prod", "team=agentcore"],
      { env: "prod", team: "agentcore" },
    ],
    ["equals signs in values", ["config=a=b=c"], { config: "a=b=c" }],
    ["a JSON object", ['{"env":"prod","team":"agentcore"}'], { env: "prod", team: "agentcore" }],
  ] as const)("parses %s", (_label, values, expected) => {
    expect(parseTags(values ? [...values] : values)).toEqual(expected);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseTags(["{not json}"])).toThrow("Invalid JSON");
  });

  test("rejects JSON array (not an object)", () => {
    expect(() => parseTags(['["team=ml"]'])).toThrow("must be an object");
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

  test.each([
    ["reserved keys", ["aws:managed=true"], "Invalid key in record"],
    ["blank keys", [" =value"], "Invalid key in record"],
    ["invalid key characters", ["team#name=value"], "Invalid key in record"],
    ["values over 256 characters", [`key=${"v".repeat(257)}`], "256 characters or less"],
    [
      "more than 50 tags",
      Array.from({ length: 51 }, (_, index) => `key${index}=value`),
      "Maximum 50 tags",
    ],
  ])("rejects %s", (_label, values, message) => {
    expect(() => parseTags(values)).toThrow(message);
  });
});

describe("tagsFlag", () => {
  test("provides the shared schema, description, help, and optional group", () => {
    const result = tagsFlag({ group: "Configuration:" });

    expect(result.name).toBe("tags");
    expect(result.description).toBe("tags as repeated key=value entries or one JSON object");
    expect(result.help).toContain("Repeat --tags for key=value entries");
    expect(result.group).toBe("Configuration:");
    expect(result.schema.safeParse(["team=agentcore"]).success).toBe(true);
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

describe("resolveResource", () => {
  const credentials = async () => ({ accessKeyId: "target", secretAccessKey: "secret" });
  const project = {
    name: "orders",
    rootPath: "/orders",
    spec: ProjectSpecSchema.parse({
      name: "orders",
      version: 2,
      agentCoreGateways: [{ name: "tools", targets: [] }],
    }),
  };

  function setup() {
    const core = new TestCoreClient();
    const lookups: ResolveDeployedResourceInput[] = [];
    Object.assign(core, {
      projectManager: {
        resolveDeployedResource: async (_project, input) => {
          lookups.push(input);
          return {
            resourceType: input.resourceType,
            name: input.name,
            id: "tools-AbCd",
            target: { name: input.target, account: "111122223333", region: "eu-west-1" },
            credentialProvider: credentials,
          };
        },
      } as Partial<ProjectManager>,
    });
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-west-2")
      .withValue(ProjectKey, project);
    return { core, ctx, lookups };
  }

  test("resolves a project name with the target's region and credentials", async () => {
    const { core, ctx, lookups } = setup();

    expect(await resolveResource(core, ctx, "gateway", "tools", "prod")).toEqual({
      id: "tools-AbCd",
      region: "eu-west-1",
      credentials,
    });
    expect(lookups).toEqual([{ target: "prod", resourceType: "gateway", name: "tools" }]);
  });

  test.each([
    ["an ID in the current region", "gw-1", { id: "gw-1", region: "us-west-2" }],
    [
      "an ARN in its own region",
      "arn:aws:bedrock-agentcore:ap-south-1:111122223333:gateway/gw-1",
      { id: "gw-1", region: "ap-south-1" },
    ],
  ])("resolves %s without any lookup", async (_name, identifier, expected) => {
    const { core, ctx, lookups } = setup();

    expect(await resolveResource(core, ctx, "gateway", identifier, "prod")).toEqual(expected);
    expect(lookups).toEqual([]);
    expect(core.gateway.calls).toEqual([]);
  });
});
