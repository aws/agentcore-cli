import { describe, expect, test } from "bun:test";
import type {
  GetAgentRuntimeResponse,
  GetGatewayResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectSpecSchema } from "../projectSchemas/project";
import { ProjectKey, ProjectTargetKey, ValueContext } from "../router";
import { TestCoreClient } from "../testing";
import { RegionKey } from "./keys";
import type { ProjectManager, ResolvedProjectResource } from "./project/types";
import {
  assertMutuallyExclusiveFlags,
  parseJsonArrayFlag,
  parseJsonObjectFlag,
  parseTags,
  toResourceArn,
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

describe("toResourceArn", () => {
  const arn = (region: string, resource: string) =>
    `arn:aws:bedrock-agentcore:${region}:111122223333:${resource}`;
  const project = {
    name: "orders",
    rootPath: "/orders",
    spec: ProjectSpecSchema.parse({
      name: "orders",
      version: 2,
      runtimes: [
        {
          name: "checkout",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/checkout",
          runtimeVersion: "PYTHON_3_14",
        },
      ],
      harnesses: [{ name: "support", path: "app/support" }],
      agentCoreGateways: [{ name: "tools", targets: [] }],
    }),
  };
  const deployed: ResolvedProjectResource[] = [
    { resourceType: "runtime", name: "checkout", deploymentState: "local-only" },
    {
      resourceType: "harness",
      name: "support",
      deploymentState: "deployed",
      arn: arn("eu-west-1", "harness/support-AbCd"),
    },
    {
      resourceType: "gateway",
      name: "tools",
      deploymentState: "deployed",
      arn: arn("eu-west-1", "gateway/tools-AbCd"),
    },
  ];
  const notFound = new ResourceNotFoundException({ message: "not found", $metadata: {} });

  function setup(options: { inProject: boolean; error?: Error }) {
    const core = new TestCoreClient();
    const targets: string[] = [];
    Object.assign(core, {
      projectManager: {
        resolveProjectResources: async (_project, { target }) => {
          targets.push(target);
          return { resources: deployed, target: { name: target } };
        },
      } as Partial<ProjectManager>,
    });
    core.runtime
      .setGetResponse({
        agentRuntimeArn: arn("us-west-2", "runtime/rt"),
      } as GetAgentRuntimeResponse)
      .setError(options.error);
    core.harness
      .setGetResponse({ harness: { arn: arn("us-west-2", "harness/hs") } } as GetHarnessResponse)
      .setError(options.error);
    core.gateway
      .setGetResponse({ gatewayArn: arn("us-west-2", "gateway/gw") } as GetGatewayResponse)
      .setError(options.error);
    let ctx = ValueContext.EmptyContext().withValue(RegionKey, "us-west-2");
    if (options.inProject) {
      ctx = ctx.withValue(ProjectKey, project).withValue(ProjectTargetKey, "prod");
    }
    const lookups = () =>
      [...core.runtime.calls, ...core.harness.calls, ...core.gateway.calls]
        .filter(({ method }) => method.startsWith("get"))
        .map(({ args }) => [args[0], (args[1] as { region: string }).region]);
    return { core, ctx, targets, lookups };
  }

  test.each([
    [
      "a project harness by name",
      "harness",
      "support",
      arn("eu-west-1", "harness/support-AbCd"),
      [],
    ],
    ["a project gateway by name", "gateway", "tools", arn("eu-west-1", "gateway/tools-AbCd"), []],
    ["a Runtime ID", "runtime", "rt", arn("us-west-2", "runtime/rt"), [["rt", "us-west-2"]]],
    ["a harness ID", "harness", "hs", arn("us-west-2", "harness/hs"), [["hs", "us-west-2"]]],
    ["a Gateway ID", "gateway", "gw", arn("us-west-2", "gateway/gw"), [["gw", "us-west-2"]]],
    [
      "an ARN, in its own region",
      "runtime",
      arn("ap-south-1", "runtime/rt"),
      arn("us-west-2", "runtime/rt"),
      [["rt", "ap-south-1"]],
    ],
  ] as const)("resolves %s", async (_name, resourceType, identifier, expected, lookups) => {
    const fixture = setup({ inProject: true });

    expect(await toResourceArn(fixture.core, fixture.ctx, resourceType, identifier)).toBe(expected);
    expect(fixture.lookups()).toEqual(lookups as unknown as string[][]);
    expect(fixture.targets).toEqual(lookups.length === 0 ? ["prod"] : []);
  });

  test.each([
    [
      "a project name that is not deployed",
      { inProject: true },
      "runtime",
      "checkout",
      "Runtime 'checkout' is not deployed to target 'prod'. Run 'agentcore deploy --target prod' first.",
    ],
    [
      "an unknown value in a project",
      { inProject: true, error: notFound },
      "harness",
      "missing",
      "Harness 'missing' is not a project Harness (available: support) and no Harness with ID 'missing' exists in us-west-2.",
    ],
    [
      "an unknown ID outside a project",
      { inProject: false, error: notFound },
      "gateway",
      "missing",
      "No Gateway with ID 'missing' exists in us-west-2. Run from inside a project to use a project name, or pass a Gateway ID or ARN.",
    ],
    [
      "an unknown ARN",
      { inProject: false, error: notFound },
      "runtime",
      arn("us-west-2", "runtime/missing"),
      "not found",
    ],
    [
      "a service error",
      { inProject: false, error: new Error("AccessDenied") },
      "runtime",
      "rt",
      "AccessDenied",
    ],
  ] as const)("rejects %s", async (_name, options, resourceType, identifier, message) => {
    const fixture = setup(options);

    await expect(
      toResourceArn(fixture.core, fixture.ctx, resourceType, identifier),
    ).rejects.toThrow(new Error(message));
  });
});
