import { describe, expect, it, test } from "bun:test";
import { boxGatewaySpec, ProjectSpecSchema, ProjectNameSchema } from "./project";

const minimalProject = { name: "project", version: 2 };

const runtime = {
  name: "agent",
  build: "CodeZip" as const,
  entrypoint: "main.py",
  codeLocation: "./agent",
  runtimeVersion: "PYTHON_3_12" as const,
  endpoints: { LIVE: { version: 1 } },
};

describe("project custom validation", () => {
  test.each([1, 3, "2", undefined, null])("rejects project version %j", (version) => {
    const result = ProjectSpecSchema.safeParse({ ...minimalProject, version });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["version"] }));
    }
  });

  test('accepts migratedFrom "v1" (the v0 CLI\'s schema version) and nothing else', () => {
    expect(ProjectSpecSchema.parse({ ...minimalProject, migratedFrom: "v1" }).migratedFrom).toBe(
      "v1",
    );
    expect(ProjectSpecSchema.parse(minimalProject).migratedFrom).toBeUndefined();
    for (const migratedFrom of ["v0", "v2", 1, ""]) {
      expect(ProjectSpecSchema.safeParse({ ...minimalProject, migratedFrom }).success).toBe(false);
    }
  });

  test("requires an explicit project version", () => {
    expect(ProjectSpecSchema.safeParse({ name: "project" }).success).toBe(false);
  });

  it("rejects reserved project names case-insensitively", () => {
    expect(ProjectNameSchema.safeParse("OpenAI").success).toBe(false);
    expect(ProjectNameSchema.safeParse("myproject").success).toBe(true);
  });

  it("rejects duplicate resource identities", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      runtimes: [runtime, runtime],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("Duplicate agent"))).toBe(
        true,
      );
    }
  });

  it("accepts toolRuntimes and rejects the old mcpRuntimeTools key", () => {
    const toolRuntime = {
      name: "search",
      toolDefinition: {
        name: "search",
        description: "Search the catalog",
        inputSchema: { type: "object" },
      },
      compute: {
        host: "AgentCoreRuntime",
        implementation: { language: "Python", path: "tools", handler: "handler.main" },
      },
    };
    expect(
      ProjectSpecSchema.safeParse({ ...minimalProject, toolRuntimes: [toolRuntime] }).success,
    ).toBe(true);
    expect(
      ProjectSpecSchema.safeParse({ ...minimalProject, mcpRuntimeTools: [toolRuntime] }).success,
    ).toBe(false);
  });

  it("validates online evaluation agent and evaluator references", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      onlineEvalConfigs: [
        {
          name: "quality",
          agent: "missing-agent",
          evaluators: ["missing-evaluator"],
          samplingRate: 10,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("unknown agent"))).toBe(
        true,
      );
      expect(result.error.issues.some((issue) => issue.message.includes("unknown evaluator"))).toBe(
        true,
      );
    }
  });

  it("allows built-in and ARN evaluator references", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      runtimes: [runtime],
      onlineEvalConfigs: [
        {
          name: "quality",
          agent: "agent",
          evaluators: [
            "Builtin.Helpfulness",
            "arn:aws:bedrock-agentcore:us-east-1:123:evaluator/e",
          ],
          samplingRate: 10,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("validates HTTP runtime and endpoint references", () => {
    const gateway = {
      name: "gateway",
      protocolType: "None" as const,
      targets: [
        {
          name: "runtime",
          targetType: "httpRuntime" as const,
          httpRuntime: { runtime: "agent", runtimeEndpoint: "MISSING" },
        },
      ],
    };
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        runtimes: [runtime],
        agentCoreGateways: [gateway],
      }).success,
    ).toBe(false);
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        runtimes: [runtime],
        agentCoreGateways: [
          {
            ...gateway,
            targets: [
              {
                ...gateway.targets[0],
                httpRuntime: { runtime: "agent", runtimeEndpoint: "LIVE" },
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  test.each(
    ["datasets", "abTests", "unassignedTargets", "httpGateways", "$schema"].flatMap((field) =>
      [[], [{ name: "legacy" }], null, undefined, "https://example.com/schema.json"].map(
        (value) => ({ field, value }),
      ),
    ),
  )("rejects removed project field $field with value $value", ({ field, value }) => {
    const result = ProjectSpecSchema.safeParse({ ...minimalProject, [field]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: "unrecognized_keys", keys: [field] }),
      );
    }
  });

  test("does not generate removed fields when applying project defaults", () => {
    const spec = ProjectSpecSchema.parse(minimalProject);
    for (const field of ["datasets", "abTests", "unassignedTargets", "httpGateways", "$schema"]) {
      expect(spec).not.toHaveProperty(field);
    }
    expect(spec.knowledgeBases).toEqual([]);
  });

  it("validates gateway policy engine references", () => {
    const gatewayWithEngine = (policyEngineName: string) => ({
      ...minimalProject,
      agentCoreGateways: [
        {
          name: "gateway",
          targets: [],
          policyEngineConfiguration: { policyEngineName, mode: "ENFORCE" },
        },
      ],
      policyEngines: [{ name: "Guardrails" }],
    });

    expect(ProjectSpecSchema.safeParse(gatewayWithEngine("Guardrails")).success).toBe(true);
    const result = ProjectSpecSchema.safeParse(gatewayWithEngine("Missing"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes("unknown policy engine")),
      ).toBe(true);
    }
  });

  it("distinguishes project knowledge-base names from external IDs", () => {
    const target = {
      name: "knowledge",
      targetType: "connector" as const,
      connectorId: "bedrock-knowledge-bases" as const,
      configurations: [
        {
          name: "Retrieve",
          parameterValues: { knowledgeBaseId: "missing-name" },
        },
      ],
    };
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        agentCoreGateways: [{ name: "gateway", targets: [target] }],
      }).success,
    ).toBe(false);
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        agentCoreGateways: [
          {
            name: "gateway",
            targets: [
              {
                ...target,
                configurations: [
                  { name: "Retrieve", parameterValues: { knowledgeBaseId: "ABCDEFGHIJ" } },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("validates payment connector credential references and types", () => {
    const payment = {
      name: "payments",
      connectors: [
        {
          name: "stripe",
          provider: "StripePrivy" as const,
          credentialName: "credential",
        },
      ],
    };
    expect(ProjectSpecSchema.safeParse({ ...minimalProject, payments: [payment] }).success).toBe(
      false,
    );
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "credential" }],
        payments: [payment],
      }).success,
    ).toBe(false);
    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        credentials: [
          {
            authorizerType: "PaymentCredentialProvider",
            name: "credential",
            provider: "StripePrivy",
          },
        ],
        payments: [payment],
      }).success,
    ).toBe(true);
  });

  it("validates payment connector credential providers and skips credentials for Quick Create", () => {
    const credential = {
      authorizerType: "PaymentCredentialProvider" as const,
      name: "credential",
      provider: "CoinbaseCDP" as const,
    };
    const manualPayment = {
      name: "manual",
      connectors: [
        {
          name: "stripe",
          provider: "StripePrivy" as const,
          credentialName: credential.name,
        },
      ],
    };

    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        credentials: [credential],
        payments: [manualPayment],
      }).success,
    ).toBe(false);

    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        payments: [
          {
            name: "quick",
            connectors: [
              {
                name: "coinbase",
                provider: "CoinbaseCDP",
                provisionMode: "QUICK_CREATE",
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects payment manager names that collide after environment normalization", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      payments: [
        { name: "Payments", connectors: [] },
        { name: "payments", connectors: [] },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("payment manager environment name"),
        ),
      ).toBe(true);
    }
  });

  it("allows the same payment connector name under different managers", () => {
    const credential = {
      authorizerType: "PaymentCredentialProvider" as const,
      name: "credential",
      provider: "CoinbaseCDP" as const,
    };
    const connector = {
      name: "shared",
      provider: "CoinbaseCDP" as const,
      credentialName: credential.name,
    };

    expect(
      ProjectSpecSchema.safeParse({
        ...minimalProject,
        credentials: [credential],
        payments: [
          {
            name: "first",
            connectors: [connector],
          },
          {
            name: "second",
            connectors: [connector],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects credential names that derive the same environment variable prefix", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      credentials: [
        { authorizerType: "ApiKeyCredentialProvider", name: "service-key" },
        { authorizerType: "ApiKeyCredentialProvider", name: "service_key" },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes("environment variable")),
      ).toBe(true);
    }
  });

  it("rejects different credential types that derive the same environment variable", () => {
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      credentials: [
        { authorizerType: "ApiKeyCredentialProvider", name: "stripe_app_id" },
        {
          authorizerType: "PaymentCredentialProvider",
          name: "stripe",
          provider: "StripePrivy",
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("AGENTCORE_CREDENTIAL_STRIPE_APP_ID"),
        ),
      ).toBe(true);
    }
  });
});

describe("projectType", () => {
  test("is absent after a parse of a project without it, so a write-back adds no key", () => {
    expect(ProjectSpecSchema.parse(minimalProject)).not.toHaveProperty("projectType");
  });

  test('accepts "box"', () => {
    expect(ProjectSpecSchema.parse({ ...minimalProject, projectType: "box" }).projectType).toBe(
      "box",
    );
  });

  test.each([["Box"], ["standard"], [{}], [null]])("rejects %j", (projectType) => {
    expect(ProjectSpecSchema.safeParse({ ...minimalProject, projectType }).success).toBe(false);
  });

  test("rejects the old box key", () => {
    expect(ProjectSpecSchema.safeParse({ ...minimalProject, box: {} }).success).toBe(false);
  });
});

describe("gateway boundRuntime and discoveryPrefix", () => {
  const gateway = (fields: Record<string, unknown>) => ({
    name: "agent-box-egress",
    authorizerType: "AWS_IAM",
    targets: [],
    ...fields,
  });
  const parse = (fields: Record<string, unknown>) =>
    ProjectSpecSchema.safeParse({
      ...minimalProject,
      runtimes: [runtime],
      agentCoreGateways: [gateway(fields)],
    });

  test("accepts a boundRuntime that names a runtime, with a discoveryPrefix", () => {
    expect(parse({ boundRuntime: "agent", discoveryPrefix: "AGENTCORE_GATEWAY_BOX" }).success).toBe(
      true,
    );
  });

  test("rejects a boundRuntime that names no runtime", () => {
    const result = parse({ boundRuntime: "gone" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toContain(
      'Gateway "agent-box-egress" has boundRuntime "gone", but no runtime has that name',
    );
  });

  test("rejects a boundRuntime that is not a runtime name", () => {
    expect(parse({ boundRuntime: "my agent" }).success).toBe(false);
  });

  test("rejects discoveryPrefix without boundRuntime", () => {
    const result = parse({ discoveryPrefix: "AGENTCORE_GATEWAY_BOX" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toContain(
      'Gateway "agent-box-egress" sets discoveryPrefix without boundRuntime',
    );
  });

  test.each(["my-prefix", "", "1BOX"])("rejects discoveryPrefix %j", (discoveryPrefix) => {
    expect(parse({ boundRuntime: "agent", discoveryPrefix }).success).toBe(false);
  });
});

describe("Box project gateways", () => {
  const runtimeNamed = (name: string) => ({ ...runtime, name, codeLocation: `./${name}` });
  const parse = (runtimes: string[], gateways: unknown[]) =>
    ProjectSpecSchema.safeParse({
      ...minimalProject,
      projectType: "box",
      runtimes: runtimes.map(runtimeNamed),
      agentCoreGateways: gateways,
    });
  const messages = (result: ReturnType<typeof parse>) =>
    result.success ? [] : result.error.issues.map(({ message }) => message);

  test("accepts a Box project with a Box gateway for each runtime", () => {
    expect(
      parse(["agent", "search"], [boxGatewaySpec("agent"), boxGatewaySpec("search")]).success,
    ).toBe(true);
  });

  test("rejects a runtime with no Box gateway, and prints the entry to add back", () => {
    const result = parse(["agent", "search", "checkout"], [boxGatewaySpec("search")]);
    const found = messages(result);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('Runtime "agent" has no Box gateway.');
    expect(found[0]).toContain(JSON.stringify(boxGatewaySpec("agent"), null, 2));
    expect(found[1]).toContain('Runtime "checkout" has no Box gateway.');
  });

  test("finds the Box gateway by boundRuntime, not by name", () => {
    expect(parse(["agent"], [{ ...boxGatewaySpec("agent"), name: "renamed" }]).success).toBe(true);
  });

  test("does not ask for Box gateways in a project without projectType", () => {
    const result = ProjectSpecSchema.safeParse({ ...minimalProject, runtimes: [runtime] });
    expect(result.success).toBe(true);
  });
});

describe("gateway variable prefixes", () => {
  const parse = (agentCoreGateways: unknown[]) =>
    ProjectSpecSchema.safeParse({ ...minimalProject, runtimes: [runtime], agentCoreGateways });

  test("rejects two gateways bound to one runtime with the same discoveryPrefix", () => {
    const result = parse([
      { name: "one", boundRuntime: "agent", discoveryPrefix: "AGENTCORE_GATEWAY_BOX", targets: [] },
      { name: "two", boundRuntime: "agent", discoveryPrefix: "AGENTCORE_GATEWAY_BOX", targets: [] },
    ]);
    expect(result.error?.issues.map(({ message }) => message)).toEqual([
      'Gateways "one" and "two" both set AGENTCORE_GATEWAY_BOX_* on runtime "agent". Rename one gateway or give it a different discoveryPrefix',
    ]);
  });

  test("rejects a gateway named box next to a Box gateway", () => {
    const result = parse([{ name: "box", targets: [] }, boxGatewaySpec("agent")]);
    expect(result.error?.issues.map(({ message }) => message)).toEqual([
      'Gateways "box" and "agent-box-egress" both set AGENTCORE_GATEWAY_BOX_* on runtime "agent". Rename one gateway or give it a different discoveryPrefix',
    ]);
  });

  test("accepts gateways with different prefixes", () => {
    expect(parse([{ name: "tools", targets: [] }, boxGatewaySpec("agent")]).success).toBe(true);
  });
});
