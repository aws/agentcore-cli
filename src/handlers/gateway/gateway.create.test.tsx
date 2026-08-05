import { describe, expect, test } from "bun:test";
import type {
  CreateGatewayResponse,
  CreateGatewayRuleResponse,
  CreateGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
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

describe("gateway create commands", () => {
  test.each([
    ["mcp", "arn:aws:iam::123456789012:role/gateway"],
    ["http", undefined],
  ] as const)("creates a %s Gateway", async (protocol, roleArn) => {
    const response = {
      gatewayId: GATEWAY_ID,
      name: "orders",
      status: "CREATING",
    } as CreateGatewayResponse;
    const core = new TestCoreClient();
    core.gateway.setCreateResponse(response);

    const result = await run(
      [
        "gateway",
        "create",
        "--name",
        "orders",
        ...(roleArn ? ["--role-arn", roleArn] : []),
        "--protocol",
        protocol,
        "--authorizer-type",
        "AWS_IAM",
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
            ...(roleArn ? { roleArn } : {}),
            protocol,
            authorizerType: "AWS_IAM",
            tags: { env: "test", team: "agentcore" },
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("creates a guided MCP server Target", async () => {
    const response = {
      targetId: "target-1",
      name: "calendar",
      status: "CREATING",
    } as CreateGatewayTargetResponse;
    const core = new TestCoreClient();
    core.gateway.setCreateTargetResponse(response);

    const result = await run(
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        GATEWAY_ID,
        "--name",
        "calendar",
        "--type",
        "mcp-server",
        "--endpoint",
        "https://calendar.example.test/mcp",
      ],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "createGatewayTarget",
        args: [
          {
            gatewayIdentifier: GATEWAY_ID,
            name: "calendar",
            targetConfiguration: {
              mcp: {
                mcpServer: {
                  endpoint: "https://calendar.example.test/mcp",
                },
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("creates an exact Runtime Target without requiring a name", async () => {
    const response = { targetId: "target-1", status: "CREATING" } as CreateGatewayTargetResponse;
    const core = new TestCoreClient();
    core.gateway.setCreateTargetResponse(response);
    const targetConfiguration = {
      http: {
        agentcoreRuntime: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/runtime-1",
          qualifier: "DEFAULT",
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

    expect(core.gateway.calls[0]).toEqual({
      method: "createGatewayTarget",
      args: [
        {
          gatewayIdentifier: GATEWAY_ID,
          targetConfiguration,
        },
        { region: REGION },
      ],
    });
  });

  test("creates a Rule with exact condition and action arrays", async () => {
    const response = {
      ruleId: "rule-1",
      priority: 10,
      status: "ACTIVE",
    } as CreateGatewayRuleResponse;
    const core = new TestCoreClient();
    core.gateway.setCreateRuleResponse(response);
    const conditions = [{ matchPaths: { anyOf: ["/orders/*"] } }];
    const actions = [{ routeToTarget: { staticRoute: { targetName: "orders-api" } } }];

    const result = await run(
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

    expect(core.gateway.calls).toEqual([
      {
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
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
});

describe("gateway create validation", () => {
  test.each([
    ["Gateway name", ["gateway", "create"], /--name/],
    ["Gateway authorizer", ["gateway", "create", "--name", "orders"], /--authorizer-type/],
    ["Target parent", ["gateway", "target", "create"], /--gateway-id/],
    ["Rule parent", ["gateway", "rule", "create"], /--gateway-id/],
  ] as const)("rejects missing %s input before calling Core", async (_name, args, error) => {
    const core = new TestCoreClient();

    await expect(run([...args], core)).rejects.toThrow(error);
    expect(core.gateway.calls).toEqual([]);
  });

  test("rejects conflicting guided and exact Target input", async () => {
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
          "--type",
          "mcp-server",
          "--endpoint",
          "https://calendar.example.test/mcp",
          "--target-configuration",
          '{"mcp":{"mcpServer":{"endpoint":"https://other.example.test/mcp"}}}',
        ],
        core,
      ),
    ).rejects.toThrow(/mutually exclusive/);
    expect(core.gateway.calls).toEqual([]);
  });
});
