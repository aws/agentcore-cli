import { describe, expect, test } from "bun:test";
import {
  TargetType,
  type GatewayRuleDetail,
  type GatewaySummary,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type ListGatewayRulesResponse,
  type ListGatewaysResponse,
  type ListGatewayTargetsResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const ENDPOINT = "https://agentcore.example.test";
const GATEWAY_ID = "gateway-1";
const TARGET_ID = "target-1";
const RULE_ID = "rule-1";

const gatewayResponse = {
  gatewayId: GATEWAY_ID,
  name: "fixture-gateway",
  status: "READY",
} as GetGatewayResponse;
const targetResponse = {
  gatewayArn: `arn:aws:bedrock-agentcore:${REGION}:123456789012:gateway/${GATEWAY_ID}`,
  targetId: TARGET_ID,
  name: "fixture-target",
  status: "READY",
} as GetGatewayTargetResponse;
const ruleResponse = {
  ruleId: RULE_ID,
  gatewayArn: `arn:aws:bedrock-agentcore:${REGION}:123456789012:gateway/${GATEWAY_ID}`,
  priority: 1,
  status: "ACTIVE",
} as GetGatewayRuleResponse;

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

describe("gateway command hierarchy", () => {
  test("registers the Gateway command hierarchy", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const gateway = root.children().find((child) => child.name() === "gateway");
    const target = gateway?.children().find((child) => child.name() === "target");
    const connector = gateway?.children().find((child) => child.name() === "connector");
    const rule = gateway?.children().find((child) => child.name() === "rule");

    expect(gateway?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(gateway?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "target",
      "connector",
      "rule",
    ]);
    expect(target?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
    expect(connector?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
    expect(rule?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
  });

  test.each([
    ["Gateway", ["gateway"]],
    ["Gateway get", ["gateway", "get"]],
    ["Gateway list", ["gateway", "list"]],
    ["Target", ["gateway", "target"]],
    ["Target get", ["gateway", "target", "get"]],
    ["Target list", ["gateway", "target", "list"]],
    ["Connector", ["gateway", "connector"]],
    ["Connector get", ["gateway", "connector", "get"]],
    ["Connector list", ["gateway", "connector", "list"]],
    ["Rule", ["gateway", "rule"]],
    ["Rule get", ["gateway", "rule", "get"]],
    ["Rule list", ["gateway", "rule", "list"]],
  ] as const)("opens the TUI for a bare %s command", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
  });
});

describe("gateway reads", () => {
  test("gets a Gateway and renders the response unchanged", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayResponse);

    const result = await run(["gateway", "get", "--id", GATEWAY_ID], core);

    expect(result.core.gateway.calls).toEqual([
      {
        method: "getGateway",
        args: [GATEWAY_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(gatewayResponse);
  });

  test("paginates Gateways with the returned token", async () => {
    const first: ListGatewaysResponse = {
      items: [{ gatewayId: GATEWAY_ID } as GatewaySummary],
      nextToken: "gateway-page-2",
    };
    const second: ListGatewaysResponse = {
      items: [{ gatewayId: "gateway-2" } as GatewaySummary],
    };
    const core = new TestCoreClient();
    core.gateway.setListResponse(first).setListResponse(second, first.nextToken);

    const firstResult = await run(["gateway", "list", "--max-results", "1"], core);
    const secondResult = await run(
      ["gateway", "list", "--max-results", "1", "--next-token", first.nextToken!],
      core,
    );

    expect(JSON.parse(firstResult.stdout)).toEqual(first);
    expect(JSON.parse(secondResult.stdout)).toEqual(second);
    expect(core.gateway.calls).toEqual([
      {
        method: "listGateways",
        args: [undefined, 1, { region: REGION }],
      },
      {
        method: "listGateways",
        args: [first.nextToken, 1, { region: REGION }],
      },
    ]);
  });

  test("gets a Gateway Target with qualified selectors and endpoint options", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetTargetResponse(targetResponse);

    const result = await run(
      [
        "gateway",
        "target",
        "get",
        "--gateway-id",
        GATEWAY_ID,
        "--target-id",
        TARGET_ID,
        "--endpoint-url",
        ENDPOINT,
      ],
      core,
    );

    expect(result.core.gateway.calls).toEqual([
      {
        method: "getGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION, endpointUrl: ENDPOINT }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(targetResponse);
  });

  test("paginates Gateway Targets with the parent ID and returned token", async () => {
    const first: ListGatewayTargetsResponse = {
      items: [{ targetId: TARGET_ID } as TargetSummary],
      nextToken: "target-page-2",
    };
    const second: ListGatewayTargetsResponse = {
      items: [{ targetId: "target-2" } as TargetSummary],
    };
    const core = new TestCoreClient();
    core.gateway.setListTargetsResponse(first).setListTargetsResponse(second, first.nextToken);

    const firstResult = await run(
      ["gateway", "target", "list", "--gateway-id", GATEWAY_ID, "--max-results", "1"],
      core,
    );
    const secondResult = await run(
      [
        "gateway",
        "target",
        "list",
        "--gateway-id",
        GATEWAY_ID,
        "--max-results",
        "1",
        "--next-token",
        first.nextToken!,
      ],
      core,
    );

    expect(JSON.parse(firstResult.stdout)).toEqual(first);
    expect(JSON.parse(secondResult.stdout)).toEqual(second);
    expect(core.gateway.calls).toEqual([
      {
        method: "listGatewayTargets",
        args: [GATEWAY_ID, undefined, 1, { region: REGION }],
      },
      {
        method: "listGatewayTargets",
        args: [GATEWAY_ID, first.nextToken, 1, { region: REGION }],
      },
    ]);
  });

  test.each([
    ["MCP", { mcp: { connector: { source: { connectorId: "web-search" } } } }],
    ["inference", { inference: { connector: { source: { connectorId: "openai" } } } }],
  ] as const)("gets a configured %s Connector", async (_kind, targetConfiguration) => {
    const core = new TestCoreClient();
    core.gateway.setGetConnectorResponse({ ...targetResponse, targetConfiguration });

    const result = await run(
      ["gateway", "connector", "get", "--gateway-id", GATEWAY_ID, "--id", TARGET_ID],
      core,
    );

    expect(result.core.gateway.calls).toEqual([
      {
        method: "getGatewayConnector",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ ...targetResponse, targetConfiguration });
  });

  test("lists only configured Connectors and preserves the service token", async () => {
    const response: ListGatewayTargetsResponse = {
      items: [{ targetId: TARGET_ID, targetType: TargetType.CONNECTOR } as TargetSummary],
      nextToken: "target-page-2",
    };
    const core = new TestCoreClient();
    core.gateway.setListConnectorsResponse(response);

    const result = await run(
      ["gateway", "connector", "list", "--gateway-id", GATEWAY_ID, "--max-results", "2"],
      core,
    );

    expect(JSON.parse(result.stdout)).toEqual(response);
    expect(result.core.gateway.calls).toEqual([
      {
        method: "listGatewayConnectors",
        args: [GATEWAY_ID, undefined, 2, { region: REGION }],
      },
    ]);
  });

  test("propagates Core validation from connector get", async () => {
    const error = new Error(`Gateway Target "${TARGET_ID}" is not connector-backed`);
    error.name = "InputValidationError";
    const core = new TestCoreClient();
    core.gateway.setError(error);

    await expect(
      run(["gateway", "connector", "get", "--gateway-id", GATEWAY_ID, "--id", TARGET_ID], core),
    ).rejects.toBe(error);
  });

  test("gets a Gateway Rule with qualified selectors", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetRuleResponse(ruleResponse);

    const result = await run(
      ["gateway", "rule", "get", "--gateway-id", GATEWAY_ID, "--rule-id", RULE_ID],
      core,
    );

    expect(result.core.gateway.calls).toEqual([
      {
        method: "getGatewayRule",
        args: [GATEWAY_ID, RULE_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(ruleResponse);
  });

  test("paginates Gateway Rules with the parent ID and returned token", async () => {
    const first: ListGatewayRulesResponse = {
      gatewayRules: [{ ruleId: RULE_ID } as GatewayRuleDetail],
      nextToken: "rule-page-2",
    };
    const second: ListGatewayRulesResponse = {
      gatewayRules: [{ ruleId: "rule-2" } as GatewayRuleDetail],
    };
    const core = new TestCoreClient();
    core.gateway.setListRulesResponse(first).setListRulesResponse(second, first.nextToken);

    const firstResult = await run(
      ["gateway", "rule", "list", "--gateway-id", GATEWAY_ID, "--max-results", "1"],
      core,
    );
    const secondResult = await run(
      [
        "gateway",
        "rule",
        "list",
        "--gateway-id",
        GATEWAY_ID,
        "--max-results",
        "1",
        "--next-token",
        first.nextToken!,
      ],
      core,
    );

    expect(JSON.parse(firstResult.stdout)).toEqual(first);
    expect(JSON.parse(secondResult.stdout)).toEqual(second);
    expect(core.gateway.calls).toEqual([
      {
        method: "listGatewayRules",
        args: [GATEWAY_ID, undefined, 1, { region: REGION }],
      },
      {
        method: "listGatewayRules",
        args: [GATEWAY_ID, first.nextToken, 1, { region: REGION }],
      },
    ]);
  });
});

describe("gateway validation and errors", () => {
  test.each([
    ["Gateway get", ["gateway", "get", "--id", ""], /--id/],
    ["Target get parent", ["gateway", "target", "get", "--target-id", TARGET_ID], /--gateway-id/],
    ["Target get child", ["gateway", "target", "get", "--gateway-id", GATEWAY_ID], /--target-id/],
    ["Target list", ["gateway", "target", "list", "--max-results", "1"], /--gateway-id/],
    ["Connector get parent", ["gateway", "connector", "get", "--id", TARGET_ID], /--gateway-id/],
    ["Connector get child", ["gateway", "connector", "get", "--gateway-id", GATEWAY_ID], /--id/],
    ["Connector list", ["gateway", "connector", "list", "--max-results", "1"], /--gateway-id/],
    ["Rule get parent", ["gateway", "rule", "get", "--rule-id", RULE_ID], /--gateway-id/],
    ["Rule get child", ["gateway", "rule", "get", "--gateway-id", GATEWAY_ID], /--rule-id/],
    ["Rule list", ["gateway", "rule", "list", "--max-results", "1"], /--gateway-id/],
  ] as const)(
    "rejects a missing selector for %s before calling Core",
    async (_name, args, error) => {
      const core = new TestCoreClient();

      await expect(run([...args], core)).rejects.toThrow(error);
      expect(core.gateway.calls).toEqual([]);
    },
  );

  test("rejects a non-numeric max-results value before calling Core", async () => {
    const core = new TestCoreClient();

    await expect(run(["gateway", "list", "--max-results", "not-a-number"], core)).rejects.toThrow(
      /Invalid value for option '--max-results'/,
    );
    expect(core.gateway.calls).toEqual([]);
  });

  test.each([
    ["Gateway", ["gateway", "get", "--id", "missing-gateway"]],
    [
      "Target",
      ["gateway", "target", "get", "--gateway-id", GATEWAY_ID, "--target-id", "missing-target"],
    ],
    ["Rule", ["gateway", "rule", "get", "--gateway-id", GATEWAY_ID, "--rule-id", "missing-rule"]],
  ] as const)("propagates ResourceNotFoundException from %s get", async (_name, args) => {
    const error = new Error("resource not found");
    error.name = "ResourceNotFoundException";
    const core = new TestCoreClient();
    core.gateway.setError(error);

    await expect(run([...args], core)).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
