import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { addGateway, cleanup, inProject, projectSpec, writeProjectSpec } =
  createGatewayProjectTestHarness("add-gateway-connector-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add gateway-connector wizard", () => {
  test("names the missing Gateway when the project has none", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/gateway-connector");

    await waitForText(r.lastFrame, "has no Gateways yet");
    expect(r.lastFrame()).toContain("agentcore project add gateway");
    r.unmount();
  });

  test("web-search asks nothing beyond a name and writes the curated configuration", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    const r = renderScreen("/agentcore/project/add/gateway-connector");

    await waitForText(r.lastFrame, "which Gateway should expose this connector?");
    expect(r.lastFrame()).toContain("● tools");
    await r.press("return");

    await waitForText(r.lastFrame, "which connector?");
    expect(r.lastFrame()).not.toContain("knowledge base");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this Target be called?");
    await r.write("web");
    await r.press("return");

    await waitForText(r.lastFrame, "this Target will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("connector web-search");
    await r.press("return");

    await waitForText(r.lastFrame, "added Connector Target 'web' to Gateway 'tools'");

    const targets = (await projectSpec(projectRoot)).agentCoreGateways[0].targets;
    expect(targets).toEqual([
      {
        name: "web",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      },
    ]);
    r.unmount();
  });

  test("bedrock-knowledge-bases asks for an ID when the project has no Knowledge Bases", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    const r = renderScreen("/agentcore/project/add/gateway-connector");

    await waitForText(r.lastFrame, "which Gateway should expose this connector?");
    await r.press("return");
    await waitForText(r.lastFrame, "which connector?");
    await r.press("down");
    await r.press("return");

    // No project Knowledge Bases, so the picker is skipped for the text step.
    await waitForText(r.lastFrame, "which Knowledge Base should it retrieve from?");
    await r.write("not valid!");
    await r.press("return");
    await waitForFlatText(r.lastFrame, "ten-character Knowledge Base ID");
    r.unmount();

    // Start over with a valid ID to confirm the shape written.
    const again = renderScreen("/agentcore/project/add/gateway-connector");
    await waitForText(again.lastFrame, "which Gateway should expose this connector?");
    await again.press("return");
    await waitForText(again.lastFrame, "which connector?");
    await again.press("down");
    await again.press("return");
    await waitForText(again.lastFrame, "which Knowledge Base should it retrieve from?");
    await again.write("ABCDEFGHIJ");
    await again.press("return");
    await waitForText(again.lastFrame, "what should this Target be called?");
    await again.write("knowledge");
    await again.press("return");
    await waitForText(again.lastFrame, "this Target will be added to agentcore.json");
    expect(flatFrame(again.lastFrame)).toContain("knowledge base ABCDEFGHIJ");
    await again.press("return");
    await waitForText(again.lastFrame, "added Connector Target 'knowledge'");

    const targets = (await projectSpec(projectRoot)).agentCoreGateways[0].targets;
    expect(targets[0]).toMatchObject({
      connectorId: "bedrock-knowledge-bases",
      configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "ABCDEFGHIJ" } }],
    });
    again.unmount();
  });

  test("offers the project's Knowledge Bases before asking for an ID", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    const spec = await projectSpec(projectRoot);
    spec.knowledgeBases = [
      { name: "docs", dataSources: [{ type: "S3", uri: "s3://bucket/docs" }] },
    ];
    await writeProjectSpec(projectRoot, spec);

    const r = renderScreen("/agentcore/project/add/gateway-connector");
    await waitForText(r.lastFrame, "which Gateway should expose this connector?");
    await r.press("return");
    await waitForText(r.lastFrame, "which connector?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "which Knowledge Base?");
    expect(r.lastFrame()).toContain("● docs");
    expect(r.lastFrame()).toContain("another Knowledge Base");
    await r.press("return");

    // A project Knowledge Base was picked, so no ID step follows.
    await waitForText(r.lastFrame, "what should this Target be called?");
    await r.write("knowledge");
    await r.press("return");
    await waitForText(r.lastFrame, "this Target will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("knowledge base docs");
    r.unmount();
  });
});
