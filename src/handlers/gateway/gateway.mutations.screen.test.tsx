import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  menuEntries,
  renderScreen,
  waitForText,
  IMPERATIVE_GLOBAL_CONFIG,
} from "../../testing";
import { DEFAULT_GLOBAL_CONFIG } from "../../globalConfig";

afterEach(cleanupScreens);
const GROUPS = ["gateway", "gateway/target", "gateway/connector", "gateway/rule"];

describe("Gateway mutation menus", () => {
  test.each(GROUPS)("%s omits disabled CLI-only mutations", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`, { globalConfig: IMPERATIVE_GLOBAL_CONFIG });
    await waitForText(screen.lastFrame, "type to choose a command");
    const entries = menuEntries(screen.lastFrame()!);
    expect(entries.cliOnly).toEqual([]);
    expect(screen.lastFrame()).not.toContain("command line only");
    expect(entries.screens).not.toContain("update");
    expect(entries.screens).not.toContain("delete");
    expect(entries.screens.includes("create")).toBe(group === "gateway");
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test.each(GROUPS)("%s preserves enabled CLI-only mutations", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`, {
      globalConfig: {
        ...DEFAULT_GLOBAL_CONFIG,
        "imperative-mutation-commands": true,
        "imperative-commands": true,
      },
    });
    await waitForText(screen.lastFrame, "command line only");
    const entries = menuEntries(screen.lastFrame()!);
    expect(entries.cliOnly).toEqual(["create", "update", "delete"]);
    expect(entries.screens).not.toContain("create");
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("disabled create opens project guidance and returns to the Gateway menu", async () => {
    const screen = renderScreen("/agentcore/gateway", { globalConfig: IMPERATIVE_GLOBAL_CONFIG });
    await waitForText(screen.lastFrame, "type to choose a command");
    expect(menuEntries(screen.lastFrame()!).screens[0]).toBe("create");
    await screen.press("return");
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
    await waitForText(screen.lastFrame, "manage AgentCore Gateways");
    expect(menuEntries(screen.lastFrame()!).cliOnly).toEqual([]);
  });

  test.each([false, true])("direct create route matches flag %s", async (enabled) => {
    const screen = renderScreen("/agentcore/gateway/create", {
      globalConfig: {
        ...DEFAULT_GLOBAL_CONFIG,
        "imperative-mutation-commands": enabled,
        "imperative-commands": true,
      },
    });
    await waitForText(
      screen.lastFrame,
      enabled ? "this command runs from the command line" : "Create an AgentCore Gateway",
    );
    expect(screen.lastFrame()?.includes("agentcore add gateway")).toBe(!enabled);
    expect(screen.lastFrame()?.includes("--authorizer-type")).toBe(enabled);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage AgentCore Gateways");
    expect(menuEntries(screen.lastFrame()!).cliOnly).toEqual(
      enabled ? ["create", "update", "delete"] : [],
    );
  });

  test.each(
    GROUPS.flatMap((group) =>
      ["create", "update", "delete"]
        .filter((mutation) => group !== "gateway" || mutation !== "create")
        .map((mutation) => `${group}/${mutation}`),
    ),
  )("disabled direct route %s cannot expose mutation help", async (path) => {
    const screen = renderScreen(`/agentcore/${path}`, { globalConfig: IMPERATIVE_GLOBAL_CONFIG });
    await waitForText(() => screen.frames.join("\n"), "Usage:");
    expect(screen.frames.join("\n")).not.toContain("this command runs from the command line");
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("project guidance remains scrollable after resizing a small terminal", async () => {
    const screen = renderScreen("/agentcore/gateway/create", {
      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    await screen.resize(50, 12);
    await screen.write("\u001b[6~");
    await waitForText(screen.lastFrame, "agentcore deploy");
    await screen.resize(100, 40);
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    expect(screen.lastFrame()).toContain("agentcore deploy");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage AgentCore Gateways");
  });
});
