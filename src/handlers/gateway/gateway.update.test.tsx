import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { CoreClient } from "../../core";
import { createControlClient, createIamClient } from "../../core/factories";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

async function runWithTestCore(args: string[]): Promise<TestCoreClient> {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return core;
}

describe("Gateway update command hierarchy", () => {
  test("registers every update leaf", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const gateway = root.children().find((child) => child.name() === "gateway")!;

    expect(gateway.children().map((child) => child.name())).toContain("update");
    for (const name of ["target", "connector", "rule"]) {
      expect(
        gateway
          .children()
          .find((child) => child.name() === name)!
          .children()
          .map((child) => child.name()),
      ).toContain("update");
    }
  });
});

describe("Gateway update validation", () => {
  test.each([
    ["Gateway selector", ["gateway", "update", "--description", "after"], /--id/],
    ["Gateway mutation", ["gateway", "update", "--id", "gateway-1"], /at least one/],
    [
      "Gateway description conflict",
      ["gateway", "update", "--id", "gateway-1", "--description", "after", "--clear-description"],
      /mutually exclusive/,
    ],
    [
      "Gateway Policy Engine conflict",
      [
        "gateway",
        "update",
        "--id",
        "gateway-1",
        "--clear-policy-engine",
        "--policy-engine-mode",
        "enforce",
      ],
      /conflicts/,
    ],
    ["Target selector", ["gateway", "target", "update", "--name", "after"], /--gateway-id/],
    [
      "Target mutation",
      ["gateway", "target", "update", "--gateway-id", "gateway-1", "--target-id", "target-1"],
      /at least one/,
    ],
    [
      "Target configuration conflict",
      [
        "gateway",
        "target",
        "update",
        "--gateway-id",
        "gateway-1",
        "--target-id",
        "target-1",
        "--endpoint",
        "https://example.test/mcp",
        "--target-configuration",
        "{}",
      ],
      /mutually exclusive/,
    ],
    [
      "Connector selector",
      ["gateway", "connector", "update", "--connector", "web-search"],
      /--gateway-id/,
    ],
    [
      "Connector mutation",
      ["gateway", "connector", "update", "--gateway-id", "gateway-1", "--id", "target-1"],
      /at least one/,
    ],
    ["Rule selector", ["gateway", "rule", "update", "--priority", "20"], /--gateway-id/],
    [
      "Rule mutation",
      ["gateway", "rule", "update", "--gateway-id", "gateway-1", "--rule-id", "rule-1"],
      /at least one/,
    ],
  ] as const)("rejects invalid %s input", async (_name, args, error) => {
    await expect(runWithTestCore([...args])).rejects.toThrow(error);
  });
});

describe("Gateway update patch mapping", () => {
  test("maps Gateway set and clear flags", async () => {
    const core = await runWithTestCore([
      "gateway",
      "update",
      "--id",
      "gateway-1",
      "--description",
      "after",
      "--clear-protocol",
      "--policy-engine-mode",
      "enforce",
      "--clear-exception-level",
    ]);

    expect(core.gateway.calls.find((call) => call.method === "updateGateway")?.args[0]).toEqual({
      id: "gateway-1",
      description: "after",
      clearProtocol: true,
      policyEngineConfiguration: { mode: "ENFORCE" },
      exceptionLevel: null,
    });
  });

  test("maps Target replacement and clear flags", async () => {
    const core = await runWithTestCore([
      "gateway",
      "target",
      "update",
      "--gateway-id",
      "gateway-1",
      "--target-id",
      "target-1",
      "--target-configuration",
      '{"http":{"passthrough":{"endpoint":"https://example.test","protocolType":"CUSTOM"}}}',
      "--clear-description",
      "--clear-credential-provider-configurations",
    ]);

    expect(
      core.gateway.calls.find((call) => call.method === "updateGatewayTarget")?.args[0],
    ).toEqual({
      gatewayId: "gateway-1",
      targetId: "target-1",
      description: null,
      targetConfiguration: {
        http: { passthrough: { endpoint: "https://example.test", protocolType: "CUSTOM" } },
      },
      credentialProviderConfigurations: null,
    });
  });

  test("maps a curated Connector replacement", async () => {
    const core = await runWithTestCore([
      "gateway",
      "connector",
      "update",
      "--gateway-id",
      "gateway-1",
      "--id",
      "target-1",
      "--connector",
      "web-search",
    ]);

    expect(
      core.gateway.calls.find((call) => call.method === "updateGatewayConnector")?.args[0],
    ).toEqual({
      gatewayId: "gateway-1",
      targetId: "target-1",
      targetConfiguration: {
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
      },
    });
  });

  test("maps Rule PATCH fields", async () => {
    const core = await runWithTestCore([
      "gateway",
      "rule",
      "update",
      "--gateway-id",
      "gateway-1",
      "--rule-id",
      "rule-1",
      "--priority",
      "20",
      "--clear-conditions",
      "--description",
      "after",
    ]);

    expect(core.gateway.calls.find((call) => call.method === "updateGatewayRule")?.args[0]).toEqual(
      {
        gatewayIdentifier: "gateway-1",
        ruleId: "rule-1",
        priority: 20,
        conditions: [],
        description: "after",
      },
    );
  });
});

const REGION = "us-east-1";
const FIXTURES = join(import.meta.dir, "__fixtures__", "update");
const RESOURCE_STATE = join(FIXTURES, "resources.json");
const GATEWAY_NAME = "agentcore-cli-gateway-update-fixture";
const ROLE_NAME = "AgentCoreCliGatewayUpdateFixtureRole";
const POLICY_NAME = "AgentCoreCliGatewayUpdateFixture";
const HTTP_TARGET_NAME = "http-update-fixture";
const CONNECTOR_TARGET_NAME = "web-search-update-fixture";
const FLOW_TIMEOUT = 600_000;

type FixtureState = {
  gatewayId: string;
  gatewayArn: string;
  targetId: string;
  connectorId: string;
  ruleId: string;
};

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function runFixture(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

async function waitUntil<T>(
  operation: () => Promise<T>,
  done: (response: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await operation();
    if (done(response)) return response;
    await Bun.sleep(2_000);
  }
  throw new Error("Timed out waiting for fixture resource state");
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

// Prerequisites use direct clients so recording Update never rewrites Create-owned fixtures.
async function setup(): Promise<FixtureState> {
  const control = createControlClient({ region: REGION });
  const iam = createIamClient({ region: REGION });
  const role = await iam.send(
    new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );
  if (!role.Role?.Arn) throw new Error("IAM did not return the fixture role ARN");

  const gateway = await control.send(
    new CreateGatewayCommand({
      name: GATEWAY_NAME,
      roleArn: role.Role.Arn,
      authorizerType: "NONE",
      description: "Gateway before update",
    }),
  );
  if (!gateway.gatewayId || !gateway.gatewayArn) {
    throw new Error("CreateGateway did not return fixture identifiers");
  }
  await waitUntil(
    () => control.send(new GetGatewayCommand({ gatewayIdentifier: gateway.gatewayId })),
    (response) => response.status === "READY",
  );

  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: POLICY_NAME,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeGateway",
            Resource: gateway.gatewayArn,
          },
          {
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeWebSearch",
            Resource: "arn:aws:bedrock-agentcore:us-east-1:aws:tool/web-search.v1",
          },
        ],
      }),
    }),
  );

  const target = await control.send(
    new CreateGatewayTargetCommand({
      gatewayIdentifier: gateway.gatewayId,
      name: HTTP_TARGET_NAME,
      description: "Target before update",
      targetConfiguration: {
        http: {
          passthrough: {
            endpoint: "https://example.com",
            protocolType: "CUSTOM",
          },
        },
      },
    }),
  );
  const connector = await control.send(
    new CreateGatewayTargetCommand({
      gatewayIdentifier: gateway.gatewayId,
      name: CONNECTOR_TARGET_NAME,
      description: "Connector before update",
      targetConfiguration: {
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
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    }),
  );
  if (!target.targetId || !connector.targetId) {
    throw new Error("CreateGatewayTarget did not return fixture identifiers");
  }
  await Promise.all(
    [target.targetId, connector.targetId].map((targetId) =>
      waitUntil(
        () =>
          control.send(
            new GetGatewayTargetCommand({
              gatewayIdentifier: gateway.gatewayId,
              targetId,
            }),
          ),
        (response) => response.status === "READY",
      ),
    ),
  );

  const rule = await control.send(
    new CreateGatewayRuleCommand({
      gatewayIdentifier: gateway.gatewayId,
      priority: 10,
      actions: [
        {
          routeToTarget: {
            staticRoute: {
              targetName: HTTP_TARGET_NAME,
            },
          },
        },
      ],
      description: "Rule before update",
    }),
  );
  if (!rule.ruleId) throw new Error("CreateGatewayRule did not return the fixture rule ID");
  await waitUntil(
    () =>
      control.send(
        new GetGatewayRuleCommand({
          gatewayIdentifier: gateway.gatewayId,
          ruleId: rule.ruleId,
        }),
      ),
    (response) => response.status === "ACTIVE",
  );

  const state = {
    gatewayId: gateway.gatewayId,
    gatewayArn: gateway.gatewayArn,
    targetId: target.targetId,
    connectorId: connector.targetId,
    ruleId: rule.ruleId,
  };
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(RESOURCE_STATE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function cleanup(state: FixtureState): Promise<void> {
  const control = createControlClient({ region: REGION });
  const iam = createIamClient({ region: REGION });
  await ignoreMissing(() =>
    control.send(
      new DeleteGatewayRuleCommand({
        gatewayIdentifier: state.gatewayId,
        ruleId: state.ruleId,
      }),
    ),
  );
  await waitUntilMissing(() =>
    control.send(
      new GetGatewayRuleCommand({
        gatewayIdentifier: state.gatewayId,
        ruleId: state.ruleId,
      }),
    ),
  );
  for (const targetId of [state.targetId, state.connectorId]) {
    await ignoreMissing(() =>
      control.send(
        new DeleteGatewayTargetCommand({
          gatewayIdentifier: state.gatewayId,
          targetId,
        }),
      ),
    );
    await waitUntilMissing(() =>
      control.send(
        new GetGatewayTargetCommand({
          gatewayIdentifier: state.gatewayId,
          targetId,
        }),
      ),
    );
  }
  await ignoreMissing(() =>
    control.send(new DeleteGatewayCommand({ gatewayIdentifier: state.gatewayId })),
  );
  await waitUntilMissing(() =>
    control.send(new GetGatewayCommand({ gatewayIdentifier: state.gatewayId })),
  );
  await ignoreMissing(() =>
    iam.send(new DeleteRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: POLICY_NAME })),
  );
  await ignoreMissing(() => iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAME })));
}

async function verify<T>(
  operation: () => Promise<T>,
  done: (response: T) => boolean,
): Promise<void> {
  if (!isRecording()) return;
  await waitUntil(operation, done);
}

test(
  "updates a Gateway, Target, Connector, and Rule through the real Core",
  async () => {
    const state = isRecording()
      ? await setup()
      : (JSON.parse(readFileSync(RESOURCE_STATE, "utf8")) as FixtureState);
    const control = createControlClient({ region: REGION });

    try {
      const gatewayStdout = await runFixture([
        "gateway",
        "update",
        "--id",
        state.gatewayId,
        "--description",
        "Gateway after update",
      ]);
      matchGolden(FIXTURES, "gateway-update.golden.json", gatewayStdout);
      expect(JSON.parse(gatewayStdout).description).toBe("Gateway after update");
      await verify(
        () => control.send(new GetGatewayCommand({ gatewayIdentifier: state.gatewayId })),
        (response) =>
          response.status === "READY" && response.description === "Gateway after update",
      );

      const targetStdout = await runFixture([
        "gateway",
        "target",
        "update",
        "--gateway-id",
        state.gatewayId,
        "--target-id",
        state.targetId,
        "--description",
        "Target after update",
      ]);
      matchGolden(FIXTURES, "target-update.golden.json", targetStdout);
      expect(JSON.parse(targetStdout).description).toBe("Target after update");
      await verify(
        () =>
          control.send(
            new GetGatewayTargetCommand({
              gatewayIdentifier: state.gatewayId,
              targetId: state.targetId,
            }),
          ),
        (response) => response.status === "READY" && response.description === "Target after update",
      );

      const connectorStdout = await runFixture([
        "gateway",
        "connector",
        "update",
        "--gateway-id",
        state.gatewayId,
        "--id",
        state.connectorId,
        "--description",
        "Connector after update",
      ]);
      matchGolden(FIXTURES, "connector-update.golden.json", connectorStdout);
      expect(JSON.parse(connectorStdout).description).toBe("Connector after update");
      await verify(
        () =>
          control.send(
            new GetGatewayTargetCommand({
              gatewayIdentifier: state.gatewayId,
              targetId: state.connectorId,
            }),
          ),
        (response) =>
          response.status === "READY" && response.description === "Connector after update",
      );

      const ruleStdout = await runFixture([
        "gateway",
        "rule",
        "update",
        "--gateway-id",
        state.gatewayId,
        "--rule-id",
        state.ruleId,
        "--priority",
        "20",
        "--description",
        "Rule after update",
      ]);
      matchGolden(FIXTURES, "rule-update.golden.json", ruleStdout);
      const updatedRule = JSON.parse(ruleStdout);
      expect(updatedRule.priority).toBe(20);
      expect(updatedRule.description).toBe("Rule after update");
      await verify(
        () =>
          control.send(
            new GetGatewayRuleCommand({
              gatewayIdentifier: state.gatewayId,
              ruleId: state.ruleId,
            }),
          ),
        (response) =>
          response.status === "ACTIVE" &&
          response.priority === 20 &&
          response.description === "Rule after update",
      );
    } finally {
      if (isRecording()) await cleanup(state);
    }
  },
  FLOW_TIMEOUT,
);
