import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  waitForFlatText,
  waitForText,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-gateway-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add gateway wizard", () => {
  test("adds the same unrestricted Gateway as the default flag path", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    expect(screen.lastFrame()).toContain("letters, digits and hyphens");
    expect(screen.lastFrame()).not.toContain("underscores");
    await screen.write("tools");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should inbound callers authenticate?");
    expect(screen.lastFrame()).toContain("● NONE (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "enable semantic search over this Gateway's tools?");
    expect(screen.lastFrame()).toContain("● off (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Gateway will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("authorizer NONE");
    expect(flatFrame(screen.lastFrame)).toContain("semantic search off");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Gateway 'tools' to 'TestProject'");
    expect((await projectSpec(projectRoot)).agentCoreGateways).toEqual([
      {
        name: "tools",
        protocolType: "None",
        targets: [],
        authorizerType: "NONE",
        enableSemanticSearch: false,
        exceptionLevel: "NONE",
      },
    ]);
    screen.unmount();
  });

  test("enabling semantic search also selects the required MCP protocol", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    await screen.write("search");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should inbound callers authenticate?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "enable semantic search over this Gateway's tools?");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Gateway will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("semantic search on");
    expect(review).toContain("protocol MCP");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Gateway 'search'");
    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      protocolType: "MCP",
      enableSemanticSearch: true,
    });
    screen.unmount();
  });

  test("collects a guided CUSTOM_JWT configuration without exposing raw JSON", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    await screen.write("secure");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should inbound callers authenticate?");
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "configure the OIDC issuer");
    await screen.write("https://idp.example.com/.well-known/openid-configuration");
    await screen.press("return");
    await screen.write("agentcore-cli, internal-tools");
    await screen.press("return");

    await waitForText(screen.lastFrame, "enable semantic search over this Gateway's tools?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this Gateway will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("authorizer CUSTOM_JWT");
    expect(review).toContain("allowed clients agentcore-cli, internal-tools");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Gateway 'secure'");
    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedClients: ["agentcore-cli", "internal-tools"],
        },
      },
    });
    screen.unmount();
  });

  test("validates the CUSTOM_JWT discovery URL before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    await screen.write("secure");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should inbound callers authenticate?");
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "configure the OIDC issuer");
    await screen.write("http://idp.example.com");
    await screen.press("return");
    await waitForText(screen.lastFrame, "OIDC discovery URL must use HTTPS");

    expect(screen.lastFrame()).toContain("configure the OIDC issuer");
    screen.unmount();
  });

  test("requires at least one CUSTOM_JWT client before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    await screen.write("secure");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should inbound callers authenticate?");
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "configure the OIDC issuer");
    await screen.write("https://idp.example.com/.well-known/openid-configuration");
    await screen.press("return");
    await screen.press("return");

    await waitForText(screen.lastFrame, "At least one OAuth client ID is required");
    expect(screen.lastFrame()).toContain("configure the OIDC issuer");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([
        {
          name: "production",
          account: "111122223333",
          region: "us-east-1",
        },
      ]),
    );
    const name = `g${"x".repeat(77)}`;
    const screen = renderScreen("/agentcore/add/gateway");

    await waitForText(screen.lastFrame, "what should this Gateway be called?");
    await screen.write(name);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 101 characters. The maximum is 100.");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("TestProject-production-");
    expect(frame).toContain("what should this Gateway be called?");
    screen.unmount();
  });
});
