import { describe, expect, it } from "bun:test";
import { ProjectSpecSchema, ProjectNameSchema } from "./project";

const minimalProject = { name: "project", version: 1 };

const runtime = {
  name: "agent",
  build: "CodeZip" as const,
  entrypoint: "main.py",
  codeLocation: "./agent",
  runtimeVersion: "PYTHON_3_12" as const,
  endpoints: { LIVE: { version: 1 } },
};

describe("project custom validation", () => {
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

  it("validates target-based AB test gateway and target references", () => {
    const abTest = {
      name: "experiment",
      mode: "target-based" as const,
      gatewayRef: "{{gateway:gateway}}",
      variants: [
        {
          name: "C" as const,
          weight: 50,
          variantConfiguration: { target: { targetName: "control" } },
        },
        {
          name: "T1" as const,
          weight: 50,
          variantConfiguration: { target: { targetName: "missing" } },
        },
      ],
      evaluationConfig: { onlineEvaluationConfigArn: "arn:evaluation" },
    };
    const result = ProjectSpecSchema.safeParse({
      ...minimalProject,
      agentCoreGateways: [
        {
          name: "gateway",
          targets: [{ name: "control", targetType: "connector", connectorId: "web-search" }],
        },
      ],
      abTests: [abTest],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('target "missing"'))).toBe(
        true,
      );
    }
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
