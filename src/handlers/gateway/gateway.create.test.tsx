import { describe, expect, test } from "bun:test";
import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-1";

async function run(
  args: string[],
  core = new TestCoreClient(),
): Promise<{ core: TestCoreClient; stdout: string }> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout() };
}

function createdTargetInput(core: TestCoreClient): Record<string, unknown> {
  return core.gateway.calls[0]!.args[0] as Record<string, unknown>;
}

describe("gateway create commands", () => {
  test("creates an unrestricted Gateway with the complete flag surface", async () => {
    const core = new TestCoreClient();
    await run(
      [
        "gateway",
        "create",
        "--name",
        "orders",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://auth.example.test","allowedClients":["client"]}}',
        "--protocol-configuration",
        '{"mcp":{"supportedVersions":["2025-03-26"]}}',
        "--interceptor-configurations",
        '[{"interceptor":{"lambda":{"arn":"arn:aws:lambda:us-west-2:123456789012:function:guard"}},"interceptionPoints":["REQUEST"]}]',
        "--policy-engine-arn",
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
        "--policy-engine-mode",
        "enforce",
        "--exception-level",
        "debug",
        "--tags",
        "env=test",
        "team=agentcore",
      ],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "createGateway",
        args: [
          {
            name: "orders",
            authorizerType: "CUSTOM_JWT",
            authorizerConfiguration: {
              customJWTAuthorizer: {
                discoveryUrl: "https://auth.example.test",
                allowedClients: ["client"],
              },
            },
            protocolConfiguration: { mcp: { supportedVersions: ["2025-03-26"] } },
            interceptorConfigurations: [
              {
                interceptor: {
                  lambda: {
                    arn: "arn:aws:lambda:us-west-2:123456789012:function:guard",
                  },
                },
                interceptionPoints: ["REQUEST"],
              },
            ],
            policyEngineConfiguration: {
              arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
              mode: "ENFORCE",
            },
            exceptionLevel: "DEBUG",
            tags: { env: "test", team: "agentcore" },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("maps --protocol mcp without requiring protocol configuration", async () => {
    const core = new TestCoreClient();
    await run(
      [
        "gateway",
        "create",
        "--name",
        "mcp-only",
        "--role-arn",
        "arn:aws:iam::123456789012:role/gateway",
        "--protocol",
        "mcp",
        "--authorizer-type",
        "AWS_IAM",
      ],
      core,
    );

    expect(core.gateway.calls[0]!.args[0]).toEqual({
      name: "mcp-only",
      roleArn: "arn:aws:iam::123456789012:role/gateway",
      protocol: "mcp",
      authorizerType: "AWS_IAM",
    });
  });

  test("creates an MCP server Target from the endpoint shortcut", async () => {
    const core = new TestCoreClient();
    await run(
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "calendar",
        "--endpoint",
        "https://calendar.example.test/mcp",
        "--tool-schema",
        '{"tools":[]}',
      ],
      core,
    );

    expect(createdTargetInput(core)).toEqual({
      gatewayIdentifier: GATEWAY_ID,
      name: "calendar",
      targetConfiguration: {
        mcp: {
          mcpServer: {
            endpoint: "https://calendar.example.test/mcp",
            mcpToolSchema: { inlinePayload: '{"tools":[]}' },
          },
        },
      },
    });
  });

  test("creates an exact Target with authentication, metadata, and network configuration", async () => {
    const core = new TestCoreClient();
    const targetConfiguration = {
      inference: { provider: { endpoint: "https://inference.example.test" } },
    };
    const credentials = [{ credentialProviderType: "CALLER_IAM_CREDENTIALS" }];
    const metadata = { allowedRequestHeaders: ["x-request-id"] };
    const privateEndpoint = {
      selfManagedLatticeResource: {
        resourceConfigurationIdentifier:
          "arn:aws:vpc-lattice:us-west-2:123456789012:resourceconfiguration/rcfg-123",
      },
    };

    await run(
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "inference",
        "--target-configuration",
        JSON.stringify(targetConfiguration),
        "--credential-provider-configurations",
        JSON.stringify(credentials),
        "--metadata-configuration",
        JSON.stringify(metadata),
        "--private-endpoint",
        JSON.stringify(privateEndpoint),
      ],
      core,
    );

    expect(createdTargetInput(core)).toEqual({
      gatewayIdentifier: GATEWAY_ID,
      name: "inference",
      targetConfiguration,
      credentialProviderConfigurations: credentials,
      metadataConfiguration: metadata,
      privateEndpoint,
    });
  });

  test("creates an exact Runtime Target without requiring a name", async () => {
    const core = new TestCoreClient();
    const targetConfiguration: TargetConfiguration = {
      http: {
        agentcoreRuntime: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders",
          qualifier: "prod",
        },
      },
    };

    await run(
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--target-configuration",
        JSON.stringify(targetConfiguration),
      ],
      core,
    );

    expect(createdTargetInput(core)).toEqual({
      gatewayIdentifier: GATEWAY_ID,
      targetConfiguration,
    });
  });

  test.each([
    [
      ["--connector", "web-search"],
      { mcp: { connector: { source: { connectorId: "web-search" } } } },
    ],
    [
      ["--connector", "bedrock-knowledge-bases", "--knowledge-base-id", "KB12345678"],
      {
        mcp: {
          connector: {
            source: { connectorId: "bedrock-knowledge-bases" },
            configurations: [
              {
                name: "Retrieve",
                parameterValues: { knowledgeBaseId: "KB12345678" },
              },
            ],
          },
        },
      },
    ],
    [
      ["--connector", "bedrock-mantle"],
      { inference: { connector: { source: { connectorId: "bedrock-mantle" } } } },
    ],
  ] as [string[], TargetConfiguration][])(
    "creates a curated Connector Target",
    async (args, targetConfiguration) => {
      const core = new TestCoreClient();
      await run(
        [
          "gateway",
          "connector",
          "create",
          "--gateway-id",
          GATEWAY_ID,
          "--name",
          "connector",
          ...args,
        ],
        core,
      );

      expect(createdTargetInput(core)).toEqual({
        gatewayIdentifier: GATEWAY_ID,
        name: "connector",
        targetConfiguration,
      });
    },
  );

  test("creates a Connector from exact connector-backed Target JSON", async () => {
    const core = new TestCoreClient();
    const targetConfiguration = {
      inference: { connector: { source: { connectorId: "openai" } } },
    };

    await run(
      [
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "openai",
        "--connector-configuration",
        JSON.stringify(targetConfiguration),
      ],
      core,
    );

    expect(createdTargetInput(core)).toEqual({
      gatewayIdentifier: GATEWAY_ID,
      name: "openai",
      targetConfiguration,
    });
  });

  test("creates a Rule with exact condition and action arrays", async () => {
    const core = new TestCoreClient();
    const conditions = [{ matchPaths: { anyOf: ["/orders/*"] } }];
    const actions = [{ routeToTarget: { staticRoute: { targetName: "orders-api" } } }];

    await run(
      [
        "gateway",
        "rule",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--priority",
        "10",
        "--conditions",
        JSON.stringify(conditions),
        "--actions",
        JSON.stringify(actions),
      ],
      core,
    );

    expect(core.gateway.calls[0]).toEqual({
      method: "createGatewayRule",
      args: [
        {
          gatewayIdentifier: GATEWAY_ID,
          priority: 10,
          conditions,
          actions,
        },
        { region: REGION },
      ],
    });
  });
});

describe("gateway create validation", () => {
  test.each([
    ["Gateway name", ["gateway", "create"], /--name/],
    ["Gateway authorizer", ["gateway", "create", "--name", "orders"], /--authorizer-type/],
    ["Target parent", ["gateway", "target", "create"], /--gateway-id/],
    [
      "Target input",
      ["gateway", "target", "create", "--gateway-id", GATEWAY_ID],
      /specify exactly one/,
    ],
    [
      "Target name",
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--endpoint",
        "https://example.test/mcp",
      ],
      /Target name/,
    ],
    [
      "Target tool schema",
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "calendar",
        "--target-configuration",
        '{"mcp":{"mcpServer":{"endpoint":"https://example.test/mcp"}}}',
        "--tool-schema",
        '{"tools":[]}',
      ],
      /--tool-schema requires --endpoint/,
    ],
    [
      "Connector name",
      ["gateway", "connector", "create", "--gateway-id", GATEWAY_ID, "--connector", "web-search"],
      /--name/,
    ],
    [
      "Knowledge Base ID",
      [
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "kb",
        "--connector",
        "bedrock-knowledge-bases",
      ],
      /--knowledge-base-id/,
    ],
    ["Rule parent", ["gateway", "rule", "create"], /--gateway-id/],
  ] as const)("rejects missing or inconsistent %s before Core", async (_name, args, error) => {
    const core = new TestCoreClient();

    await expect(run([...args], core)).rejects.toThrow(error);
    expect(core.gateway.calls).toEqual([]);
  });

  test("rejects multiple Target input modes", async () => {
    const core = new TestCoreClient();

    await expect(
      run(
        [
          "gateway",
          "target",
          "create",
          "--gateway-id",
          GATEWAY_ID,
          "--name",
          "calendar",
          "--endpoint",
          "https://calendar.example.test/mcp",
          "--target-configuration",
          '{"mcp":{"mcpServer":{"endpoint":"https://other.example.test/mcp"}}}',
        ],
        core,
      ),
    ).rejects.toThrow(/specify exactly one/);
    expect(core.gateway.calls).toEqual([]);
  });

  test("rejects a non-Connector exact configuration", async () => {
    const core = new TestCoreClient();

    await expect(
      run(
        [
          "gateway",
          "connector",
          "create",
          "--gateway-id",
          GATEWAY_ID,
          "--name",
          "not-connector",
          "--connector-configuration",
          '{"mcp":{"mcpServer":{"endpoint":"https://example.test/mcp"}}}',
        ],
        core,
      ),
    ).rejects.toThrow(/connector Target/);
    expect(core.gateway.calls).toEqual([]);
  });
});
