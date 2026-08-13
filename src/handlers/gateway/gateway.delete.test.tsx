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
  type DeleteGatewayResponse,
  type DeleteGatewayRuleResponse,
  type DeleteGatewayTargetResponse,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  type GetGatewayTargetResponse,
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

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-1";
const TARGET_ID = "target-1";
const RULE_ID = "rule-1";

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

describe("gateway delete commands", () => {
  test("deletes a Gateway", async () => {
    const response = { gatewayId: GATEWAY_ID, status: "DELETING" } as DeleteGatewayResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteResponse(response);

    const result = await run(["gateway", "delete", "--id", GATEWAY_ID], core);

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGateway",
        args: [GATEWAY_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("deletes a Target", async () => {
    const response = { targetId: TARGET_ID, status: "DELETING" } as DeleteGatewayTargetResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteTargetResponse(response);

    const result = await run(
      ["gateway", "target", "delete", "--gateway-id", GATEWAY_ID, "--target-id", TARGET_ID],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("deletes a connector-backed Target", async () => {
    const response = { targetId: TARGET_ID, status: "DELETING" } as DeleteGatewayTargetResponse;
    const core = new TestCoreClient();
    core.gateway
      .setGetTargetResponse({
        targetId: TARGET_ID,
        targetConfiguration: {
          mcp: { connector: { source: { connectorId: "web-search" } } },
        },
      } as GetGatewayTargetResponse)
      .setDeleteTargetResponse(response);

    const result = await run(
      ["gateway", "connector", "delete", "--gateway-id", GATEWAY_ID, "--id", TARGET_ID],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "getGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
      {
        method: "deleteGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("rejects a non-connector Target without deleting it", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetTargetResponse({
      targetId: TARGET_ID,
      targetConfiguration: {
        http: { passthrough: { endpoint: "https://example.test", protocolType: "CUSTOM" } },
      },
    } as GetGatewayTargetResponse);

    await expect(
      run(["gateway", "connector", "delete", "--gateway-id", GATEWAY_ID, "--id", TARGET_ID], core),
    ).rejects.toThrow(/not connector-backed/);
    expect(core.gateway.calls).toEqual([
      {
        method: "getGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
    ]);
  });

  test("deletes a Rule", async () => {
    const response = { ruleId: RULE_ID, status: "DELETING" } as DeleteGatewayRuleResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteRuleResponse(response);

    const result = await run(
      ["gateway", "rule", "delete", "--gateway-id", GATEWAY_ID, "--rule-id", RULE_ID],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGatewayRule",
        args: [GATEWAY_ID, RULE_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
});

describe("gateway delete validation", () => {
  test.each([
    ["Gateway selector", ["gateway", "delete"], /--id/],
    ["Target parent", ["gateway", "target", "delete"], /--gateway-id/],
    ["Target selector", ["gateway", "target", "delete", "--gateway-id", GATEWAY_ID], /--target-id/],
    ["Connector parent", ["gateway", "connector", "delete"], /--gateway-id/],
    ["Connector selector", ["gateway", "connector", "delete", "--gateway-id", GATEWAY_ID], /--id/],
    ["Rule parent", ["gateway", "rule", "delete"], /--gateway-id/],
    ["Rule selector", ["gateway", "rule", "delete", "--gateway-id", GATEWAY_ID], /--rule-id/],
  ] as const)("rejects a missing %s before calling Core", async (_name, args, error) => {
    const core = new TestCoreClient();

    await expect(run([...args], core)).rejects.toThrow(error);
    expect(core.gateway.calls).toEqual([]);
  });
});

const FIXTURES = join(import.meta.dir, "__fixtures__", "delete");
const RESOURCE_STATE = join(FIXTURES, "resources.json");
const GATEWAY_NAME = "agentcore-cli-gateway-delete-fixture";
const ROLE_NAME = "AgentCoreCliGatewayDeleteFixtureRole";
const POLICY_NAME = "AgentCoreCliGatewayDeleteFixture";
const HTTP_TARGET_NAME = "http-delete-fixture";
const CONNECTOR_TARGET_NAME = "web-search-delete-fixture";
const FLOW_TIMEOUT = 600_000;

type FixtureState = {
  gatewayId: string;
  gatewayArn: string;
  targetId: string;
  connectorId: string;
  ruleId: string;
};

type FixtureResources = {
  gatewayId?: string;
  targetIds: string[];
  ruleId?: string;
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
  await root.route(["node", "agentcore", ...args, "--region", "us-east-1"]);
  return io.stdout();
}

class GatewayDeleteFixture {
  private readonly control = createControlClient({ region: "us-east-1" });
  private readonly iam = createIamClient({ region: "us-east-1" });

  async setup(resources: FixtureResources): Promise<FixtureState> {
    await this.ignoreMissing(() =>
      this.iam.send(new DeleteRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: POLICY_NAME })),
    );
    await this.ignoreMissing(() => this.iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAME })));
    const role = await this.iam.send(
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
    await Bun.sleep(10_000);

    const gateway = await this.control.send(
      new CreateGatewayCommand({
        name: GATEWAY_NAME,
        roleArn: role.Role.Arn,
        authorizerType: "NONE",
        description: "Disposable Gateway Delete fixture",
      }),
    );
    if (!gateway.gatewayId || !gateway.gatewayArn) {
      throw new Error("CreateGateway did not return fixture identifiers");
    }
    resources.gatewayId = gateway.gatewayId;
    await this.waitUntil(
      () => this.control.send(new GetGatewayCommand({ gatewayIdentifier: gateway.gatewayId })),
      (response) => response.status === "READY",
    );

    await this.iam.send(
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

    const target = await this.control.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: gateway.gatewayId,
        name: HTTP_TARGET_NAME,
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
    if (!target.targetId) {
      throw new Error("CreateGatewayTarget did not return the fixture Target ID");
    }
    resources.targetIds.push(target.targetId);

    const connector = await this.control.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: gateway.gatewayId,
        name: CONNECTOR_TARGET_NAME,
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
    if (!connector.targetId) {
      throw new Error("CreateGatewayTarget did not return the fixture Connector ID");
    }
    resources.targetIds.push(connector.targetId);
    await Promise.all(
      [target.targetId, connector.targetId].map((targetId) =>
        this.waitUntil(
          () =>
            this.control.send(
              new GetGatewayTargetCommand({
                gatewayIdentifier: gateway.gatewayId,
                targetId,
              }),
            ),
          (response) => response.status === "READY",
        ),
      ),
    );

    const rule = await this.control.send(
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
      }),
    );
    if (!rule.ruleId) throw new Error("CreateGatewayRule did not return the fixture rule ID");
    resources.ruleId = rule.ruleId;
    await this.waitUntil(
      () =>
        this.control.send(
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

  async verifyMissing(operation: () => Promise<unknown>): Promise<void> {
    if (!isRecording()) return;
    await this.waitUntilMissing(operation);
  }

  async cleanup(resources: FixtureResources): Promise<void> {
    if (resources.gatewayId && resources.ruleId) {
      await this.ignoreMissing(() =>
        this.control.send(
          new DeleteGatewayRuleCommand({
            gatewayIdentifier: resources.gatewayId,
            ruleId: resources.ruleId,
          }),
        ),
      );
      await this.waitUntilMissing(() =>
        this.control.send(
          new GetGatewayRuleCommand({
            gatewayIdentifier: resources.gatewayId,
            ruleId: resources.ruleId,
          }),
        ),
      );
    }

    if (resources.gatewayId) {
      for (const targetId of resources.targetIds) {
        await this.ignoreMissing(() =>
          this.control.send(
            new DeleteGatewayTargetCommand({
              gatewayIdentifier: resources.gatewayId,
              targetId,
            }),
          ),
        );
        await this.waitUntilMissing(() =>
          this.control.send(
            new GetGatewayTargetCommand({
              gatewayIdentifier: resources.gatewayId,
              targetId,
            }),
          ),
        );
      }
      await this.ignoreMissing(() =>
        this.control.send(new DeleteGatewayCommand({ gatewayIdentifier: resources.gatewayId })),
      );
      await this.waitUntilMissing(() =>
        this.control.send(new GetGatewayCommand({ gatewayIdentifier: resources.gatewayId })),
      );
    }

    await this.ignoreMissing(() =>
      this.iam.send(
        new DeleteRolePolicyCommand({
          RoleName: ROLE_NAME,
          PolicyName: POLICY_NAME,
        }),
      ),
    );
    await this.ignoreMissing(() => this.iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAME })));
  }

  private async waitUntil<T>(
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

  private async waitUntilMissing(operation: () => Promise<unknown>): Promise<void> {
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

  private async ignoreMissing(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!["ResourceNotFoundException", "NoSuchEntityException"].includes((error as Error).name)) {
        throw error;
      }
    }
  }
}

test(
  "deletes a Rule, Target, Connector, and Gateway through the real Core",
  async () => {
    const fixture = new GatewayDeleteFixture();
    const resources: FixtureResources = { targetIds: [] };

    try {
      const state = isRecording()
        ? await fixture.setup(resources)
        : (JSON.parse(readFileSync(RESOURCE_STATE, "utf8")) as FixtureState);

      const ruleStdout = await runFixture([
        "gateway",
        "rule",
        "delete",
        "--gateway-id",
        state.gatewayId,
        "--rule-id",
        state.ruleId,
      ]);
      matchGolden(FIXTURES, "rule-delete.golden.json", ruleStdout);
      expect(JSON.parse(ruleStdout).ruleId).toBe(state.ruleId);
      await fixture.verifyMissing(() =>
        createControlClient({ region: "us-east-1" }).send(
          new GetGatewayRuleCommand({
            gatewayIdentifier: state.gatewayId,
            ruleId: state.ruleId,
          }),
        ),
      );

      const targetStdout = await runFixture([
        "gateway",
        "target",
        "delete",
        "--gateway-id",
        state.gatewayId,
        "--target-id",
        state.targetId,
      ]);
      matchGolden(FIXTURES, "target-delete.golden.json", targetStdout);
      expect(JSON.parse(targetStdout).targetId).toBe(state.targetId);
      await fixture.verifyMissing(() =>
        createControlClient({ region: "us-east-1" }).send(
          new GetGatewayTargetCommand({
            gatewayIdentifier: state.gatewayId,
            targetId: state.targetId,
          }),
        ),
      );

      const connectorStdout = await runFixture([
        "gateway",
        "connector",
        "delete",
        "--gateway-id",
        state.gatewayId,
        "--id",
        state.connectorId,
      ]);
      matchGolden(FIXTURES, "connector-delete.golden.json", connectorStdout);
      expect(JSON.parse(connectorStdout).targetId).toBe(state.connectorId);
      await fixture.verifyMissing(() =>
        createControlClient({ region: "us-east-1" }).send(
          new GetGatewayTargetCommand({
            gatewayIdentifier: state.gatewayId,
            targetId: state.connectorId,
          }),
        ),
      );

      const gatewayStdout = await runFixture(["gateway", "delete", "--id", state.gatewayId]);
      matchGolden(FIXTURES, "gateway-delete.golden.json", gatewayStdout);
      expect(JSON.parse(gatewayStdout).gatewayId).toBe(state.gatewayId);
      await fixture.verifyMissing(() =>
        createControlClient({ region: "us-east-1" }).send(
          new GetGatewayCommand({ gatewayIdentifier: state.gatewayId }),
        ),
      );
    } finally {
      if (isRecording()) await fixture.cleanup(resources);
    }
  },
  FLOW_TIMEOUT,
);
