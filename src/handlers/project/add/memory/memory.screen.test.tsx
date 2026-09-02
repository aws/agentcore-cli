import { test, expect, describe, afterEach } from "bun:test";
import { renderScreen, waitForText, flatFrame, cleanupScreens } from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import {
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
} from "../../../../projectSchemas/memory";

// The wizard resolves the project from process.cwd(), exactly as the
// flag-driven path does, so the tests run inside a real scaffolded project.
const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-memory-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add memory wizard", () => {
  test("default flow: name → strategies → retention → description → review", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.write("conversations");
    await r.press("return");

    // SEMANTIC is checked by default; enter accepts the selection.
    await waitForText(r.lastFrame, "what should be extracted from raw events?");
    expect(r.lastFrame()).toContain("SEMANTIC");
    await r.press("return");

    // Retention is prefilled with the service default.
    await waitForText(r.lastFrame, "how long should raw events be kept?");
    expect(r.lastFrame()).toContain("30");
    await r.press("return");

    await waitForText(r.lastFrame, "what does this memory store?");
    await r.press("return");

    await waitForText(r.lastFrame, "this memory will be added to agentcore.json");
    // The review table reports every answer the wizard collected.
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("memory conversations");
    expect(review).toContain("strategies SEMANTIC");
    expect(review).toContain("event expiry 30 days");

    await r.press("return");

    await waitForText(r.lastFrame, "added memory 'conversations' to 'TestProject'");

    // A picked strategy expands to the same namespaces the shorthand expands to.
    expect((await projectSpec(projectRoot)).memories).toEqual([
      {
        name: "conversations",
        eventExpiryDuration: 30,
        strategies: [
          {
            type: "SEMANTIC",
            namespaceTemplates: DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.SEMANTIC,
          },
        ],
      },
    ]);
    r.unmount();
  });

  test("toggling strategies writes each one's default namespaces", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.write("episodes");
    await r.press("return");

    await waitForText(r.lastFrame, "what should be extracted from raw events?");
    // Uncheck SEMANTIC (cursor starts on it), then check EPISODIC.
    await r.write(" ");
    await r.press("down");
    await r.press("down");
    await r.press("down");
    await r.write(" ");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.press("return");
    await waitForText(r.lastFrame, "what does this memory store?");
    await r.press("return");
    await waitForText(r.lastFrame, "this memory will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("strategies EPISODIC");
    await r.press("return");

    await waitForText(r.lastFrame, "added memory 'episodes'");

    // EPISODIC additionally carries reflection namespaces, as its schema demands.
    expect((await projectSpec(projectRoot)).memories[0].strategies).toEqual([
      {
        type: "EPISODIC",
        namespaceTemplates: DEFAULT_STRATEGY_NAMESPACE_TEMPLATES.EPISODIC,
        reflectionNamespaceTemplates: DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
      },
    ]);
    r.unmount();
  });

  test("a blank name does not advance", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.press("return");

    await waitForText(r.lastFrame, "memory name is required");
    // Still on the name step.
    expect(r.lastFrame()).toContain("what should this memory be called?");
    r.unmount();
  });

  test("retention outside 3-365 reports the flag's own bounds", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.write("shortlived");
    await r.press("return");
    await waitForText(r.lastFrame, "what should be extracted from raw events?");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    // Clear the prefilled 30 and enter something out of range.
    for (let i = 0; i < 2; i++) await r.write("\u007F");
    await r.write("400");
    await r.press("return");

    // The schema's own message, not a copy of the bounds.
    await waitForText(r.lastFrame, "Too big: expected number to be <=365");
    expect(r.lastFrame()).toContain("how long should raw events be kept?");
    r.unmount();
  });

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });

  test("esc on a later step goes back a question", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "what should this memory be called?");
    await r.write("conversations");
    await r.press("return");

    await waitForText(r.lastFrame, "what should be extracted from raw events?");
    await r.press("escape");

    await waitForText(r.lastFrame, "what should this memory be called?");
    // The answer survives the round trip.
    expect(r.lastFrame()).toContain("conversations");
    r.unmount();
  });

  test("reports the CLI's own guidance outside a project", async () => {
    const r = renderScreen("/agentcore/project/add/memory");

    await waitForText(r.lastFrame, "No AgentCore project found");
    expect(r.lastFrame()).toContain("agentcore project create");
    r.unmount();
  });
});
