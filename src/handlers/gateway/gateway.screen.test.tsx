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
import { cleanupScreens, renderScreen, TestCoreClient, waitForText } from "../../testing";

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

describe("Gateway browse", () => {
  test("renders Gateway identity and calls list with exact Core options", async () => {
    const core = coreWithGateways([gateway()]);
    const screen = renderScreen("/agentcore/gateway", { core, endpointUrl: ENDPOINT });

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
    const loading = renderScreen("/agentcore/gateway", { core: loadingCore });

    await waitForText(loading.lastFrame, "Loading Gateways");
    await loading.press("escape");
    await waitForText(loading.lastFrame, "the platform for production AI agents");
    loading.unmount();

    const empty = renderScreen("/agentcore/gateway");
    await waitForText(empty.lastFrame, "No Gateways found in this Region.");
    empty.unmount();

    const errorCore = new TestCoreClient();
    errorCore.gateway.setError(new Error("gateway unavailable"));
    const error = renderScreen("/agentcore/gateway", { core: errorCore });

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
    const screen = renderScreen("/agentcore/gateway", { core, endpointUrl: ENDPOINT });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");
    await waitForText(screen.lastFrame, "show the full JSON definition");
    expect(screen.lastFrame()).toContain(`agentcore → gateway → ${GATEWAY_ID}`);
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
    const screen = renderScreen(`/agentcore/gateway/browse/${encodeURIComponent(GATEWAY_ID)}`, {
      core,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"gatewayId"');
    expect(screen.lastFrame()).toContain('"roleArn"');
    await screen.press("escape");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });
});

describe("Gateway nested browse", () => {
  test("browses Targets and opens the selected Target JSON", async () => {
    const core = new TestCoreClient();
    core.gateway
      .setListTargetsResponse({
        items: [target(TARGET_ID, "orders-target", TargetType.PASSTHROUGH)],
      })
      .setGetTargetResponse(targetDetail(TARGET_ID));
    const screen = renderScreen(
      `/agentcore/gateway/browse/${encodeURIComponent(GATEWAY_ID)}/targets`,
      { core, endpointUrl: ENDPOINT },
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
    await waitForText(screen.lastFrame, '"targetId"');
    expect(core.gateway.calls.at(-1)).toEqual({
      method: "getGatewayTarget",
      args: [GATEWAY_ID, TARGET_ID, { region: "us-east-1", endpointUrl: ENDPOINT }],
    });
  });

  test("filters Connectors and opens the selected Connector JSON", async () => {
    const core = new TestCoreClient();
    core.gateway
      .setListTargetsResponse({
        items: [
          target(TARGET_ID, "ordinary-target", TargetType.PASSTHROUGH),
          target(CONNECTOR_ID, "search-connector", TargetType.CONNECTOR),
        ],
      })
      .setGetTargetResponse(targetDetail(CONNECTOR_ID, true));
    const screen = renderScreen(
      `/agentcore/gateway/browse/${encodeURIComponent(GATEWAY_ID)}/connectors`,
      { core },
    );

    await waitForText(screen.lastFrame, "search-connector");
    expect(screen.lastFrame()).not.toContain("ordinary-target");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"targetConfiguration"');
    expect(screen.lastFrame()).toContain('"web-search"');
  });

  test("browses Rules and opens the selected Rule JSON", async () => {
    const core = new TestCoreClient();
    core.gateway.setListRulesResponse({ gatewayRules: [rule()] }).setGetRuleResponse(ruleDetail());
    const screen = renderScreen(
      `/agentcore/gateway/browse/${encodeURIComponent(GATEWAY_ID)}/rules`,
      { core },
    );

    await waitForText(screen.lastFrame, "Route orders");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"ruleId"');
    expect(core.gateway.calls.at(-1)).toEqual({
      method: "getGatewayRule",
      args: [GATEWAY_ID, RULE_ID, { region: "us-east-1", endpointUrl: undefined }],
    });
  });

  test("keeps nested lists empty and retryable without exposing write actions", async () => {
    const core = new TestCoreClient();
    core.gateway.setError(new Error("targets unavailable"));
    const screen = renderScreen(
      `/agentcore/gateway/browse/${encodeURIComponent(GATEWAY_ID)}/targets`,
      { core },
    );

    await waitForText(screen.lastFrame, "targets unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");
    for (const excluded of ["create", "update", "delete"]) {
      expect(screen.lastFrame()).not.toMatch(new RegExp(`\\b${excluded}\\b`));
    }
    core.gateway.setError(undefined);
    core.gateway.setListTargetsResponse({ items: [] });
    await screen.write("r");
    await waitForText(screen.lastFrame, "This Gateway has no Targets.");
  });
});
