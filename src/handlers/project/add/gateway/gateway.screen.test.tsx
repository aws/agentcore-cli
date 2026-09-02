import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-gateway-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add gateway wizard", () => {
  test("default flow writes the same defaults the flag-driven path writes", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/gateway");

    await waitForText(r.lastFrame, "what should this Gateway be called?");
    await r.write("tools");
    await r.press("return");

    // Protocol: None is the preselected default.
    await waitForText(r.lastFrame, "which Target types should this Gateway accept?");
    expect(r.lastFrame()).toContain("● None (default)");
    await r.press("return");

    await waitForText(r.lastFrame, "how should inbound callers be authorized?");
    expect(r.lastFrame()).toContain("● NONE (default)");
    await r.press("return");

    // Neither the JWT step nor the semantic-search step applies to these answers.
    await waitForText(r.lastFrame, "what is this Gateway for?");
    await r.press("return");

    await waitForText(r.lastFrame, "this Gateway will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("gateway tools");
    expect(review).toContain("protocol None");
    expect(review).toContain("authorizer NONE");
    await r.press("return");

    await waitForText(r.lastFrame, "added Gateway 'tools' to 'TestProject'");

    const gateways = (await projectSpec(projectRoot)).agentCoreGateways;
    expect(gateways).toHaveLength(1);
    expect(gateways[0]).toMatchObject({
      name: "tools",
      protocolType: "None",
      authorizerType: "NONE",
      targets: [],
      enableSemanticSearch: false,
      exceptionLevel: "NONE",
    });
    r.unmount();
  });

  test("the semantic-search step appears only for MCP", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/gateway");

    await waitForText(r.lastFrame, "what should this Gateway be called?");
    await r.write("mcp");
    await r.press("return");

    await waitForText(r.lastFrame, "which Target types should this Gateway accept?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "how should inbound callers be authorized?");
    await r.press("return");

    // The MCP-only step is now in the flow.
    await waitForText(r.lastFrame, "should tools be searchable by meaning?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "what is this Gateway for?");
    await r.press("return");
    await waitForText(r.lastFrame, "this Gateway will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("protocol MCP");
    expect(review).toContain("semantic search on");
    await r.press("return");

    await waitForText(r.lastFrame, "added Gateway 'mcp'");
    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      protocolType: "MCP",
      enableSemanticSearch: true,
    });
    r.unmount();
  });

  test("CUSTOM_JWT adds a configuration step and validates its JSON", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/gateway");

    await waitForText(r.lastFrame, "what should this Gateway be called?");
    await r.write("jwt");
    await r.press("return");

    await waitForText(r.lastFrame, "which Target types should this Gateway accept?");
    await r.press("return");

    await waitForText(r.lastFrame, "how should inbound callers be authorized?");
    await r.press("down");
    await r.press("down");
    await r.press("return");

    // The branch step only exists for CUSTOM_JWT.
    await waitForText(r.lastFrame, "paste the authorizerConfiguration for your JWT issuer");

    // Malformed JSON is refused before the wizard advances.
    await r.write("{ not json");
    await r.write("\x04"); // ctrl+d attempts to continue
    await waitForText(r.lastFrame, "is not valid JSON");
    // Still on the configuration step.
    expect(r.lastFrame()).toContain("paste the authorizerConfiguration");
    r.unmount();
  });

  test("the JWT step rejects the SDK authorizer shape, as the flag path does", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/gateway");

    await waitForText(r.lastFrame, "what should this Gateway be called?");
    await r.write("jwt");
    await r.press("return");
    await waitForText(r.lastFrame, "which Target types should this Gateway accept?");
    await r.press("return");
    await waitForText(r.lastFrame, "how should inbound callers be authorized?");
    await r.press("down");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "paste the authorizerConfiguration for your JWT issuer");

    // The SDK's casing is well-formed JSON of the wrong shape. The step must
    // name the stray key rather than accept it: the project schema would only
    // reject it later, at submit, as a missing customJwtAuthorizer.
    await r.write(
      '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration"}}',
    );
    await r.write("\x04");
    await waitForFlatText(r.lastFrame, "customJWTAuthorizer");
    expect(r.lastFrame()).toContain("paste the authorizerConfiguration");
    r.unmount();
  });

  test("a name that would exceed the service limit is rejected", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/gateway");

    await waitForText(r.lastFrame, "what should this Gateway be called?");
    // TestProject- prefix plus this name passes 48 characters.
    await r.write("a".repeat(40));
    await r.press("return");

    await waitForFlatText(r.lastFrame, "exceeds the service limit of 48 characters");
    expect(flatFrame(r.lastFrame)).toContain("what should this Gateway be called?");
    r.unmount();
  });
});
