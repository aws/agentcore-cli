import { afterEach, describe, expect, test } from "bun:test";
import {
  TargetType,
  type GatewayRuleDetail,
  type GatewaySummary,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type ListGatewaysResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitForText,
  menuEntries,
} from "../../testing";

afterEach(cleanupScreens);

const ENDPOINT = "https://agentcore.example.test";
const GATEWAY_ID = "gateway/blue one";
const TARGET_ID = "target/blue one";
const CONNECTOR_ID = "connector/blue one";
const RULE_ID = "rule/blue one";

function gateway(overrides: Partial<GatewaySummary> = {}): GatewaySummary {
  return {
    gatewayId: GATEWAY_ID,
    name: "checkout-gateway",
    status: "READY",
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    authorizerType: "AWS_IAM",
    protocolType: "MCP",
    ...overrides,
  };
}

function gatewayDetail(overrides: Partial<GetGatewayResponse> = {}): GetGatewayResponse {
  return {
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/checkout",
    gatewayId: GATEWAY_ID,
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    status: "READY",
    name: "checkout-gateway",
    authorizerType: "AWS_IAM",
    gatewayUrl: "https://checkout.gateway.example.test",
    roleArn: "arn:aws:iam::123456789012:role/gateway",
    protocolType: "MCP",
    ...overrides,
  } as GetGatewayResponse;
}

function target(targetId: string, name: string, targetType: TargetType): TargetSummary {
  return {
    targetId,
    name,
    targetType,
    status: "READY",
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
  };
}

function targetDetail(targetId: string, connector = false): GetGatewayTargetResponse {
  return {
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/checkout",
    targetId,
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    status: "READY",
    name: connector ? "search-connector" : "orders-target",
    targetConfiguration: connector
      ? { mcp: { connector: { source: { connectorId: "web-search" } } } }
      : {
          http: {
            passthrough: {
              endpoint: "https://orders.example.test",
              protocolType: "CUSTOM",
            },
          },
        },
    credentialProviderConfigurations: [],
  } as GetGatewayTargetResponse;
}

function rule(): GatewayRuleDetail {
  return {
    ruleId: RULE_ID,
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/checkout",
    priority: 10,
    actions: [{ routeToTarget: { staticRoute: { targetName: "orders-target" } } }],
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    status: "ACTIVE",
    description: "Route orders",
  };
}

function ruleDetail(): GetGatewayRuleResponse {
  return rule() as GetGatewayRuleResponse;
}

function coreWithGateways(items: GatewaySummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.gateway.setListResponse({ items });
  return core;
}

describe("Gateway menu and list", () => {
  test("renders the Gateway command menu without calling Core", async () => {
    const screen = renderScreen("/agentcore/gateway");

    await waitForText(screen.lastFrame, "inspect AgentCore Gateways");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list", "invoke", "target", "connector", "rule", "policy"],
      cliOnly: ["create", "update", "delete"],
    });
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("renders Gateway identity and calls list with exact Core options", async () => {
    const core = coreWithGateways([gateway()]);
    const screen = renderScreen("/agentcore/gateway/list", { core, endpointUrl: ENDPOINT });

    await waitForText(screen.lastFrame, "checkout-gateway");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("status");
    expect(frame).toContain("protocol");
    expect(frame).toContain("authorizer");
    expect(frame).toContain("2026-08-02 03:04");
    expect(frame).toContain("[/] filter");
    expect(core.gateway.calls).toEqual([
      {
        method: "listGateways",
        args: [undefined, expect.any(Number), { region: "us-east-1", endpointUrl: ENDPOINT }],
      },
    ]);
  });

  test("shows loading, empty, and retryable error states", async () => {
    const loadingCore = new TestCoreClient();
    const pending = Promise.withResolvers<ListGatewaysResponse>();
    loadingCore.gateway.listGateways = async () => pending.promise;
    const loading = renderScreen("/agentcore/gateway/list", { core: loadingCore });

    await waitForText(loading.lastFrame, "Loading Gateways");
    await loading.press("escape");
    await waitForText(loading.lastFrame, "inspect AgentCore Gateways");
    loading.unmount();

    const empty = renderScreen("/agentcore/gateway/list");
    await waitForText(empty.lastFrame, "No Gateways found in this Region.");
    empty.unmount();

    const errorCore = new TestCoreClient();
    errorCore.gateway.setError(new Error("gateway unavailable"));
    const error = renderScreen("/agentcore/gateway/list", { core: errorCore });

    await waitForText(error.lastFrame, "gateway unavailable");
    expect(error.lastFrame()).toContain("[r] retry");
    errorCore.gateway.setError(undefined);
    errorCore.gateway.setListResponse({ items: [gateway({ name: "recovered-gateway" })] });
    await error.write("r");
    await waitForText(error.lastFrame, "recovered-gateway");
  });

  test("selects a Gateway and renders only read-only hub actions", async () => {
    const core = coreWithGateways([gateway()]);
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen("/agentcore/gateway/list", { core, endpointUrl: ENDPOINT });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, "show the full JSON definition");
    expect(screen.lastFrame()).toContain(`agentcore → gateway → get → ${GATEWAY_ID}`);
    const frame = screen.lastFrame()!;
    for (const action of ["detail", "targets", "connectors", "rules"]) {
      expect(frame).toContain(action);
    }
    for (const excluded of ["create", "update", "delete", "invoke"]) {
      expect(frame).not.toMatch(new RegExp(`\\b${excluded}\\b`));
    }
    expect(core.gateway.calls.find((call) => call.method === "getGateway")).toEqual({
      method: "getGateway",
      args: [GATEWAY_ID, { region: "us-east-1", endpointUrl: ENDPOINT }],
    });
  });

  test("opens complete Gateway JSON from the detail action", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(`/agentcore/gateway/get/${encodeURIComponent(GATEWAY_ID)}`, {
      core,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"gatewayId"');
    expect(screen.lastFrame()).toContain('"roleArn"');
    await screen.press("escape");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("bare Gateway get redirects to the Gateway picker", async () => {
    const core = coreWithGateways([gateway({ name: "redirected-gateway" })]);
    const screen = renderScreen("/agentcore/gateway/get", { core });

    await waitForText(screen.lastFrame, "redirected-gateway");
    expect(core.gateway.calls[0]?.method).toBe("listGateways");
  });
});

describe("Gateway Target flow", () => {
  test("renders the Target command menu without calling Core", async () => {
    const screen = renderScreen("/agentcore/gateway/target");

    await waitForText(screen.lastFrame, "inspect targets for an AgentCore Gateway");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["create", "update", "delete"],
    });
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("selects a Gateway before listing Targets", async () => {
    const core = coreWithGateways([gateway()]);
    core.gateway.setListTargetsResponse({
      items: [target(TARGET_ID, "orders-target", TargetType.PASSTHROUGH)],
    });
    const screen = renderScreen("/agentcore/gateway/target/list", { core });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → gateway → target → list → ${GATEWAY_ID}`);
    await waitForText(screen.lastFrame, "orders-target");
    expect(core.gateway.calls.find((call) => call.method === "listGatewayTargets")).toEqual({
      method: "listGatewayTargets",
      args: [
        GATEWAY_ID,
        undefined,
        expect.any(Number),
        { region: "us-east-1", endpointUrl: undefined },
      ],
    });
  });

  test("opens the selected Target JSON with exact selectors", async () => {
    const core = new TestCoreClient();
    core.gateway
      .setListTargetsResponse({
        items: [target(TARGET_ID, "orders-target", TargetType.PASSTHROUGH)],
      })
      .setGetTargetResponse(targetDetail(TARGET_ID));
    const screen = renderScreen(
      `/agentcore/gateway/target/list/${encodeURIComponent(GATEWAY_ID)}`,
      {
        core,
        endpointUrl: ENDPOINT,
      },
    );

    await waitForText(screen.lastFrame, "orders-target");
    expect(core.gateway.calls[0]).toEqual({
      method: "listGatewayTargets",
      args: [
        GATEWAY_ID,
        undefined,
        expect.any(Number),
        { region: "us-east-1", endpointUrl: ENDPOINT },
      ],
    });
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → gateway → target → get → ${GATEWAY_ID} → ${TARGET_ID}`,
    );
    await waitForText(screen.lastFrame, '"targetId"');
    expect(core.gateway.calls.at(-1)).toEqual({
      method: "getGatewayTarget",
      args: [GATEWAY_ID, TARGET_ID, { region: "us-east-1", endpointUrl: ENDPOINT }],
    });
  });

  test("bare Target get redirects to Gateway selection", async () => {
    const core = coreWithGateways([gateway({ name: "target-parent" })]);
    const screen = renderScreen("/agentcore/gateway/target/get", { core });

    await waitForText(screen.lastFrame, "target-parent");
    expect(core.gateway.calls[0]?.method).toBe("listGateways");
  });

  test("unwinds Target detail through the scoped list and Gateway picker", async () => {
    const core = coreWithGateways([gateway()]);
    core.gateway
      .setListTargetsResponse({
        items: [target(TARGET_ID, "orders-target", TargetType.PASSTHROUGH)],
      })
      .setGetTargetResponse(targetDetail(TARGET_ID));
    const screen = renderScreen("/agentcore/gateway/target/list", { core });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, "orders-target");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"targetId"');

    await screen.press("escape");
    await waitForText(screen.lastFrame, `agentcore → gateway → target → list → ${GATEWAY_ID}`);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Gateway to list Targets for");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "inspect targets for an AgentCore Gateway");
  });
});

describe("Gateway Connector flow", () => {
  test("renders the separate Connector command menu without calling Core", async () => {
    const screen = renderScreen("/agentcore/gateway/connector");

    await waitForText(screen.lastFrame, "inspect connectors configured for an AgentCore Gateway");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["create", "update", "delete"],
    });
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("selects a Gateway before showing the dedicated Connector list", async () => {
    const core = coreWithGateways([gateway()]);
    core.gateway.setListConnectorsResponse({
      items: [target(CONNECTOR_ID, "search-connector", TargetType.CONNECTOR)],
    });
    const screen = renderScreen("/agentcore/gateway/connector/list", { core });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → gateway → connector → list → ${GATEWAY_ID}`);
    await waitForText(screen.lastFrame, "search-connector");
    const frame = screen.lastFrame()!;
    expect(frame).not.toContain("ordinary-target");
    expect(frame).toContain("updated UTC");
    expect(frame).not.toMatch(/\btype\b/);
  });

  test("lists Connectors and opens the selected Connector JSON", async () => {
    const core = new TestCoreClient();
    core.gateway
      .setListConnectorsResponse({
        items: [target(CONNECTOR_ID, "search-connector", TargetType.CONNECTOR)],
      })
      .setGetConnectorResponse(targetDetail(CONNECTOR_ID, true));
    const screen = renderScreen(
      `/agentcore/gateway/connector/list/${encodeURIComponent(GATEWAY_ID)}`,
      { core },
    );

    await waitForText(screen.lastFrame, "search-connector");
    expect(screen.lastFrame()).not.toContain("ordinary-target");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → gateway → connector → get → ${GATEWAY_ID} → ${CONNECTOR_ID}`,
    );
    await waitForText(screen.lastFrame, '"targetConfiguration"');
    expect(screen.lastFrame()).toContain('"web-search"');
    expect(core.gateway.calls.at(-1)).toEqual({
      method: "getGatewayConnector",
      args: [GATEWAY_ID, CONNECTOR_ID, { region: "us-east-1", endpointUrl: undefined }],
    });
  });

  test("rejects a non-Connector Target opened through the Connector route", async () => {
    const core = new TestCoreClient();
    core.gateway.setError(new Error(`Gateway Target "${TARGET_ID}" is not connector-backed`));
    const screen = renderScreen(
      `/agentcore/gateway/connector/get/${encodeURIComponent(GATEWAY_ID)}/${encodeURIComponent(TARGET_ID)}`,
      { core },
    );

    await waitForText(screen.lastFrame, `Gateway Target "${TARGET_ID}" is not connector-backed`);
    expect(screen.lastFrame()).toContain("[r] retry");
  });

  test("shows the Gateway-level empty state when no Connectors exist", async () => {
    const screen = renderScreen(
      `/agentcore/gateway/connector/list/${encodeURIComponent(GATEWAY_ID)}`,
    );

    await waitForText(screen.lastFrame, "This Gateway has no Connectors.");
    expect(screen.lastFrame()).not.toContain("more →");
  });

  test("bare Connector get redirects to Gateway selection", async () => {
    const core = coreWithGateways([gateway({ name: "connector-parent" })]);
    const screen = renderScreen("/agentcore/gateway/connector/get", { core });

    await waitForText(screen.lastFrame, "connector-parent");
    expect(core.gateway.calls[0]?.method).toBe("listGateways");
  });
});

describe("Gateway Rule flow", () => {
  test("renders the Rule command menu without calling Core", async () => {
    const screen = renderScreen("/agentcore/gateway/rule");

    await waitForText(screen.lastFrame, "inspect rules for an AgentCore Gateway");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["create", "update", "delete"],
    });
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("selects a Gateway before listing Rules", async () => {
    const core = coreWithGateways([gateway()]);
    core.gateway.setListRulesResponse({ gatewayRules: [rule()] });
    const screen = renderScreen("/agentcore/gateway/rule/list", { core });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → gateway → rule → list → ${GATEWAY_ID}`);
    await waitForText(screen.lastFrame, "Route orders");
    expect(core.gateway.calls.find((call) => call.method === "listGatewayRules")).toEqual({
      method: "listGatewayRules",
      args: [
        GATEWAY_ID,
        undefined,
        expect.any(Number),
        { region: "us-east-1", endpointUrl: undefined },
      ],
    });
  });

  test("opens the selected Rule JSON with exact selectors", async () => {
    const core = new TestCoreClient();
    core.gateway.setListRulesResponse({ gatewayRules: [rule()] }).setGetRuleResponse(ruleDetail());
    const screen = renderScreen(`/agentcore/gateway/rule/list/${encodeURIComponent(GATEWAY_ID)}`, {
      core,
    });

    await waitForText(screen.lastFrame, "Route orders");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → gateway → rule → get → ${GATEWAY_ID} → ${RULE_ID}`,
    );
    await waitForText(screen.lastFrame, '"ruleId"');
    expect(core.gateway.calls.at(-1)).toEqual({
      method: "getGatewayRule",
      args: [GATEWAY_ID, RULE_ID, { region: "us-east-1", endpointUrl: undefined }],
    });
  });

  test("keeps scoped lists empty and retryable", async () => {
    const core = new TestCoreClient();
    core.gateway.setError(new Error("rules unavailable"));
    const screen = renderScreen(`/agentcore/gateway/rule/list/${encodeURIComponent(GATEWAY_ID)}`, {
      core,
    });

    await waitForText(screen.lastFrame, "rules unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");
    core.gateway.setError(undefined);
    core.gateway.setListRulesResponse({ gatewayRules: [] });
    await screen.write("r");
    await waitForText(screen.lastFrame, "This Gateway has no Rules.");
  });

  test("bare Rule get redirects to Gateway selection", async () => {
    const core = coreWithGateways([gateway({ name: "rule-parent" })]);
    const screen = renderScreen("/agentcore/gateway/rule/get", { core });

    await waitForText(screen.lastFrame, "rule-parent");
    expect(core.gateway.calls[0]?.method).toBe("listGateways");
  });
});
