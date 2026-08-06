import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { CoreClient } from "../../core";
import { createControlClient, createIamClient } from "../../core/factories";
import { GatewayExecutionRole } from "../../core/gatewayExecutionRole";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-east-1";
const GATEWAY_NAME = "agentcore-cli-gateway-create-fixture";
const HTTP_TARGET_NAME = "http-fixture";
const CONNECTOR_TARGET_NAME = "web-search-fixture";
const WEB_SEARCH_POLICY_NAME = "AgentCoreCliWebSearchFixture";
const FIXTURES = join(import.meta.dir, "__fixtures__", "create");
const FLOW_TIMEOUT = 600_000;

// Record with AWS_PROFILE=e2e-test RECORD=1 bun test src/handlers/gateway/gateway.create.test.tsx
type FixtureState = {
  gatewayId?: string;
  targetIds: string[];
  ruleId?: string;
};

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

async function pollUntil(
  args: string[],
  done: (response: Record<string, unknown>) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = JSON.parse(await run(args)) as Record<string, unknown>;
    if (done(response)) return;
    if (!isRecording()) {
      throw new Error(`Replayed fixture for \`${args.join(" ")}\` is not settled`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${args.join(" ")}\``);
}

async function ignoreMissing(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!["ResourceNotFoundException", "NoSuchEntityException"].includes((error as Error).name)) {
      throw error;
    }
  }
}

async function waitUntilMissing(operation: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await operation();
    } catch (error) {
      if ((error as Error).name === "ResourceNotFoundException") return;
      throw error;
    }
    await Bun.sleep(2_000);
  }
  throw new Error("Timed out waiting for fixture resource deletion");
}

async function deleteTarget(
  control: ReturnType<typeof createControlClient>,
  gatewayId: string,
  targetId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await control.send(
        new DeleteGatewayTargetCommand({
          gatewayIdentifier: gatewayId,
          targetId,
        }),
      );
      await waitUntilMissing(() =>
        control.send(
          new GetGatewayTargetCommand({
            gatewayIdentifier: gatewayId,
            targetId,
          }),
        ),
      );
      return;
    } catch (error) {
      if ((error as Error).name === "ResourceNotFoundException") return;
      if (
        (error as Error).name !== "ValidationException" ||
        !/valid state|Creating state/i.test((error as Error).message)
      ) {
        throw error;
      }
      await Bun.sleep(2_000);
    }
  }
  throw new Error(`Timed out deleting fixture Target "${targetId}"`);
}

async function cleanup(state: FixtureState): Promise<void> {
  if (!isRecording()) return;

  const control = createControlClient({ region: REGION });
  if (state.gatewayId && state.ruleId) {
    await ignoreMissing(() =>
      control.send(
        new DeleteGatewayRuleCommand({
          gatewayIdentifier: state.gatewayId,
          ruleId: state.ruleId,
        }),
      ),
    );
  }

  if (state.gatewayId) {
    for (const targetId of state.targetIds) {
      await deleteTarget(control, state.gatewayId, targetId);
    }

    await ignoreMissing(() =>
      control.send(new DeleteGatewayCommand({ gatewayIdentifier: state.gatewayId })),
    );
    await waitUntilMissing(() =>
      control.send(new GetGatewayCommand({ gatewayIdentifier: state.gatewayId })),
    );
  }

  const iam = createIamClient({ region: REGION });
  await ignoreMissing(() =>
    iam.send(
      new DeleteRolePolicyCommand({
        RoleName: GatewayExecutionRole.roleName(GATEWAY_NAME, REGION),
        PolicyName: WEB_SEARCH_POLICY_NAME,
      }),
    ),
  );
  await ignoreMissing(() =>
    iam.send(
      new DeleteRoleCommand({
        RoleName: GatewayExecutionRole.roleName(GATEWAY_NAME, REGION),
      }),
    ),
  );
}

describe("Gateway create validation", () => {
  test.each([
    ["Gateway name", ["gateway", "create", "--authorizer-type", "NONE"], /--name/],
    ["Gateway authorizer", ["gateway", "create", "--name", "orders"], /--authorizer-type/],
    [
      "CUSTOM_JWT configuration",
      ["gateway", "create", "--name", "orders", "--authorizer-type", "CUSTOM_JWT"],
      /CUSTOM_JWT requires --authorizer-configuration/,
    ],
    [
      "Policy Engine pair",
      [
        "gateway",
        "create",
        "--name",
        "orders",
        "--authorizer-type",
        "AWS_IAM",
        "--policy-engine-arn",
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
      ],
      /must be supplied together/,
    ],
    ["Target parent", ["gateway", "target", "create", "--name", "target"], /--gateway-id/],
    [
      "Target input",
      ["gateway", "target", "create", "--gateway-id", "gateway-1", "--name", "target"],
      /specify exactly one/,
    ],
    [
      "Target name",
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        "gateway-1",
        "--endpoint",
        "https://example.test/mcp",
      ],
      /Target name/,
    ],
    [
      "Connector name",
      ["gateway", "connector", "create", "--gateway-id", "gateway-1", "--connector", "web-search"],
      /--name/,
    ],
    [
      "Knowledge Base ID",
      [
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "kb",
        "--connector",
        "bedrock-knowledge-bases",
      ],
      /--knowledge-base-id/,
    ],
    [
      "Connector exclusivity",
      [
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "search",
        "--connector",
        "web-search",
        "--connector-configuration",
        '{"mcp":{"connector":{"source":{"connectorId":"web-search"}}}}',
      ],
      /specify exactly one/,
    ],
    [
      "Connector Knowledge Base ID",
      [
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "search",
        "--connector",
        "web-search",
        "--knowledge-base-id",
        "KB12345678",
      ],
      /--knowledge-base-id requires --connector bedrock-knowledge-bases/,
    ],
    [
      "Target tool schema",
      [
        "gateway",
        "target",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "target",
        "--target-configuration",
        "{}",
        "--tool-schema",
        "{}",
      ],
      /--tool-schema requires --endpoint/,
    ],
    ["Rule parent", ["gateway", "rule", "create", "--priority", "10"], /--gateway-id/],
    [
      "Rule priority",
      ["gateway", "rule", "create", "--gateway-id", "gateway-1", "--actions", "[]"],
      /--priority/,
    ],
    [
      "Rule actions",
      ["gateway", "rule", "create", "--gateway-id", "gateway-1", "--priority", "10"],
      /--actions/,
    ],
  ] as const)("rejects missing or inconsistent %s before Core", async (_name, args, error) => {
    await expect(run([...args])).rejects.toThrow(error);
  });

  test("rejects conflicting Target inputs", async () => {
    await expect(
      run([
        "gateway",
        "target",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "calendar",
        "--endpoint",
        "https://calendar.example.test/mcp",
        "--target-configuration",
        '{"mcp":{"mcpServer":{"endpoint":"https://other.example.test/mcp"}}}',
      ]),
    ).rejects.toThrow(/specify exactly one/);
  });

  test("rejects malformed Target JSON", async () => {
    await expect(
      run([
        "gateway",
        "target",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "broken",
        "--target-configuration",
        "{not json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--target-configuration'/);
  });

  test("rejects a non-Connector exact configuration", async () => {
    await expect(
      run([
        "gateway",
        "connector",
        "create",
        "--gateway-id",
        "gateway-1",
        "--name",
        "not-connector",
        "--connector-configuration",
        '{"mcp":{"mcpServer":{"endpoint":"https://example.test/mcp"}}}',
      ]),
    ).rejects.toThrow(/connector Target/);
  });
});

describe("Gateway fixture-backed creates", () => {
  test(
    "creates a Gateway, Target, Connector, and Rule through the real Core",
    async () => {
      const state: FixtureState = { targetIds: [] };

      try {
        const gatewayStdout = await run([
          "gateway",
          "create",
          "--name",
          GATEWAY_NAME,
          "--authorizer-type",
          "NONE",
          "--description",
          "Disposable Gateway Create fixture",
        ]);
        matchGolden(FIXTURES, "gateway-create.golden.json", gatewayStdout);
        const gateway = JSON.parse(gatewayStdout);
        expect(gateway.name).toBe(GATEWAY_NAME);
        expect(gateway.gatewayId).toBeString();
        expect(gateway.gatewayArn).toBeString();
        state.gatewayId = gateway.gatewayId;

        await pollUntil(
          ["gateway", "get", "--id", state.gatewayId!],
          (response) => response.status === "READY",
        );

        const targetStdout = await run([
          "gateway",
          "target",
          "create",
          "--gateway-id",
          state.gatewayId!,
          "--name",
          HTTP_TARGET_NAME,
          "--target-configuration",
          JSON.stringify({
            http: {
              passthrough: {
                endpoint: "https://example.com",
                protocolType: "CUSTOM",
              },
            },
          }),
        ]);
        matchGolden(FIXTURES, "target-create.golden.json", targetStdout);
        const target = JSON.parse(targetStdout);
        expect(target.targetId).toBeString();
        state.targetIds.push(target.targetId);

        await pollUntil(
          [
            "gateway",
            "target",
            "get",
            "--gateway-id",
            state.gatewayId!,
            "--target-id",
            target.targetId,
          ],
          (response) => response.status === "READY",
        );

        if (isRecording()) {
          await createIamClient({ region: REGION }).send(
            new PutRolePolicyCommand({
              RoleName: GatewayExecutionRole.roleName(GATEWAY_NAME, REGION),
              PolicyName: WEB_SEARCH_POLICY_NAME,
              PolicyDocument: JSON.stringify(webSearchPolicy(gateway.gatewayArn)),
            }),
          );
        }

        const connectorStdout = await run([
          "gateway",
          "connector",
          "create",
          "--gateway-id",
          state.gatewayId!,
          "--name",
          CONNECTOR_TARGET_NAME,
          "--connector",
          "web-search",
          "--credential-provider-configurations",
          '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]',
          "--description",
          "Disposable Gateway Connector Create fixture",
        ]);
        matchGolden(FIXTURES, "connector-create.golden.json", connectorStdout);
        const connector = JSON.parse(connectorStdout);
        expect(connector.targetId).toBeString();
        expect(connector.targetConfiguration).toEqual({
          mcp: {
            connector: {
              source: { connectorId: "web-search" },
              configurations: [
                {
                  name: "WebSearch",
                  parameterValues: { maxResults: 10 },
                },
              ],
            },
          },
        });
        state.targetIds.push(connector.targetId);

        await pollUntil(
          [
            "gateway",
            "connector",
            "get",
            "--gateway-id",
            state.gatewayId!,
            "--id",
            connector.targetId,
          ],
          (response) => response.status === "READY",
        );

        const ruleStdout = await run([
          "gateway",
          "rule",
          "create",
          "--gateway-id",
          state.gatewayId!,
          "--priority",
          "10",
          "--actions",
          JSON.stringify([
            {
              routeToTarget: {
                staticRoute: {
                  targetName: HTTP_TARGET_NAME,
                },
              },
            },
          ]),
          "--description",
          "Disposable Gateway Rule Create fixture",
        ]);
        matchGolden(FIXTURES, "rule-create.golden.json", ruleStdout);
        const rule = JSON.parse(ruleStdout);
        expect(rule.ruleId).toBeString();
        state.ruleId = rule.ruleId;

        await pollUntil(
          ["gateway", "rule", "get", "--gateway-id", state.gatewayId!, "--rule-id", state.ruleId!],
          (response) => response.status === "ACTIVE",
        );
      } finally {
        await cleanup(state);
      }
    },
    FLOW_TIMEOUT,
  );
});

function webSearchPolicy(gatewayArn: string): Record<string, unknown> {
  const [prefix, partition, service, region] = gatewayArn.split(":");
  if (prefix !== "arn" || service !== "bedrock-agentcore" || !region) {
    throw new Error(`Unexpected Gateway ARN: ${gatewayArn}`);
  }
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "bedrock-agentcore:InvokeGateway",
        Resource: gatewayArn,
      },
      {
        Effect: "Allow",
        Action: "bedrock-agentcore:InvokeWebSearch",
        Resource: `arn:${partition}:${service}:${region}:aws:tool/web-search.v1`,
      },
    ],
  };
}
