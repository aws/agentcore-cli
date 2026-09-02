import { afterEach, describe, expect, test } from "bun:test";
import type { GatewaySummary, GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { cleanupScreens, renderScreen, TestCoreClient, waitForText } from "../../../testing";

afterEach(cleanupScreens);

const GATEWAY_ID = "gw-1";
const ENGINE_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/pe-1";
const FORBID =
  "forbid (principal is AgentCore::IamEntity, action, resource is AgentCore::Gateway);";
const PERMIT = "permit (principal, action, resource is AgentCore::Gateway);";
const PLACEHOLDER = "Describe what the policy should allow or deny";

function coreWith(engineArn: string | undefined): TestCoreClient {
  const core = new TestCoreClient();
  const summary: GatewaySummary = {
    gatewayId: GATEWAY_ID,
    name: "checkout-gateway",
    status: "READY",
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    authorizerType: "AWS_IAM",
  };
  core.gateway.setListResponse({ items: [summary] });
  core.gateway.setGetResponse({
    gatewayId: GATEWAY_ID,
    name: "checkout-gateway",
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-1",
    policyEngineConfiguration: engineArn ? { arn: engineArn, mode: "ENFORCE" } : undefined,
  } as GetGatewayResponse);
  return core;
}

describe("gateway policy generate screen", () => {
  test("picks a gateway, then shows its engine and the prompt", async () => {
    const screen = renderScreen("/agentcore/gateway/policy/generate", {
      core: coreWith(ENGINE_ARN),
    });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");

    await waitForText(screen.lastFrame, ENGINE_ARN);
    const frame = screen.lastFrame()!;
    expect(frame).toContain(`agentcore → gateway → policy → generate → ${GATEWAY_ID}`);
    expect(frame).toContain(PLACEHOLDER);
    expect(frame).toContain("[enter] generate");
  });

  test("explains when the gateway has no engine and offers no prompt", async () => {
    const screen = renderScreen(`/agentcore/gateway/policy/generate/${GATEWAY_ID}`, {
      core: coreWith(undefined),
    });

    await waitForText(screen.lastFrame, "no Policy Engine attached");
    expect(screen.lastFrame()).not.toContain(PLACEHOLDER);
  });

  test("generates, renders the Cedar and findings, and edits again on e", async () => {
    const core = coreWith(ENGINE_ARN);
    core.policy.result = {
      policyGenerationId: "gen-1",
      policyEngineId: "pe-1",
      gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-1",
      policies: [
        {
          statement: FORBID,
          findings: [{ type: "DENY_ALL", description: "denies every request" }],
        },
        { statement: PERMIT, findings: [] },
      ],
    };
    const screen = renderScreen(`/agentcore/gateway/policy/generate/${GATEWAY_ID}`, { core });
    await waitForText(screen.lastFrame, PLACEHOLDER);

    await screen.write("forbid IAM callers");
    await screen.press("return");

    await waitForText(screen.lastFrame, PERMIT, 3000);
    const frame = screen.lastFrame()!;
    expect(frame).toContain(FORBID);
    expect(frame).toContain("✓ Resolving gateway");
    expect(frame).toContain("[DENY_ALL] denies every request");
    expect(frame).toContain("[e] edit prompt");
    expect(core.policy.calls[0]).toMatchObject({
      gatewayId: GATEWAY_ID,
      prompt: "forbid IAM callers",
    });
    expect(core.policy.calls[0]).not.toHaveProperty("policyEngineId");
    expect(core.policy.calls[0]!.name).toMatch(/^cli_generation_\d+$/);

    await screen.write("e");
    await waitForText(screen.lastFrame, "[enter] generate");
    expect(screen.lastFrame()).toContain("forbid IAM callers");
  });

  test("shows the error and returns to the form on esc", async () => {
    const core = coreWith(ENGINE_ARN);
    core.policy.error = new Error("policy generation 'gen-1' failed: bad prompt");
    const screen = renderScreen(`/agentcore/gateway/policy/generate/${GATEWAY_ID}`, { core });
    await waitForText(screen.lastFrame, PLACEHOLDER);

    await screen.write("x");
    await screen.press("return");

    await waitForText(screen.lastFrame, "✗ policy generation 'gen-1' failed: bad prompt", 3000);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "[enter] generate");
  });
});
