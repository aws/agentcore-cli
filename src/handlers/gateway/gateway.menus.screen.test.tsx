import { afterEach, describe, expect, test } from "bun:test";
import { cleanupScreens, menuEntries, renderScreen, waitForText } from "../../testing";

afterEach(cleanupScreens);
const GROUPS = ["gateway", "gateway/target", "gateway/connector", "gateway/rule"];

describe("Gateway menus", () => {
  // Only the Gateway menu lists "create", and it opens project guidance
  // rather than a command (see the project resource creation guidance tests).
  test.each(GROUPS)("%s lists no create, update, or delete commands", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`);
    await waitForText(screen.lastFrame, "type to choose a command");
    const entries = menuEntries(screen.lastFrame()!);
    const names = [...entries.screens, ...entries.cliOnly];
    expect(names.includes("create")).toBe(group === "gateway");
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(entries.cliOnly).toEqual([]);
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("direct create route opens project guidance and returns to the Gateway menu", async () => {
    const screen = renderScreen("/agentcore/gateway/create");
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("agentcore create");
    expect(frame).toContain("cd <project-directory>");
    expect(frame).toContain("agentcore add gateway --name MyGateway");
    expect(frame).toContain("agentcore deploy");
    expect(frame).not.toContain("agentcore gateway create");
    expect(frame).not.toContain("this command runs from the command line");
    expect(screen.core.gateway.calls).toEqual([]);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "inspect AgentCore Gateways");
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test.each(
    GROUPS.flatMap((group) =>
      ["create", "update", "delete"]
        .filter((mutation) => group !== "gateway" || mutation !== "create")
        .map((mutation) => `${group}/${mutation}`),
    ),
  )("direct route %s cannot expose mutation help", async (path) => {
    const screen = renderScreen(`/agentcore/${path}`);
    await waitForText(() => screen.frames.join("\n"), "Usage:");
    expect(screen.frames.join("\n")).not.toContain("this command runs from the command line");
    expect(screen.frames.join("\n")).not.toContain(`agentcore ${path.replaceAll("/", " ")}`);
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("project guidance remains scrollable after resizing a small terminal", async () => {
    const screen = renderScreen("/agentcore/gateway/create");
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    await screen.resize(50, 12);
    await screen.write("\u001b[6~");
    await waitForText(screen.lastFrame, "agentcore deploy");
    await screen.resize(100, 40);
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    expect(screen.lastFrame()).toContain("agentcore deploy");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "inspect AgentCore Gateways");
  });
});
