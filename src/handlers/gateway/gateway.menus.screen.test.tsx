import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  IMPERATIVE_GLOBAL_CONFIG,
  menuEntries,
  renderScreen,
  waitForText,
} from "../../testing";
import { DEFAULT_GLOBAL_CONFIG } from "../../globalConfig";

afterEach(cleanupScreens);
const GROUPS = ["gateway", "gateway/target", "gateway/connector", "gateway/rule"];

describe("Gateway menus", () => {
  test.each(GROUPS)("%s redirects to root when the parent flag is off", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`);
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    await waitForText(screen.lastFrame, "type to choose a command");
    const entries = menuEntries(screen.lastFrame()!);
    expect(entries.screens).not.toContain("gateway");
    expect(entries.cliOnly).not.toContain("create");
    expect(entries.cliOnly).not.toContain("delete");
    expect(screen.frames.join("\n")).not.toContain("manage AgentCore Gateways");
    expect(screen.frames.join("\n")).not.toContain("this command runs from the command line");
    expect(screen.core.gateway.calls).toEqual([]);
  });

  // Only the Gateway menu lists "create", and it opens project guidance
  // rather than a command (see the project resource creation guidance tests).
  test.each(GROUPS)("%s lists no create or update commands when enabled", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`, {
      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });
    await waitForText(screen.lastFrame, "type to choose a command");
    const entries = menuEntries(screen.lastFrame()!);
    const names = [...entries.screens, ...entries.cliOnly];
    expect(names.includes("create")).toBe(group === "gateway");
    expect(names).not.toContain("update");
    expect(entries.cliOnly).toEqual(group === "gateway" ? [] : ["delete"]);
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test("disabled direct create opens project guidance and returns to root", async () => {
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
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expect(menuEntries(screen.lastFrame()!).screens).not.toContain("gateway");
  });

  test.each([false, true])(
    "direct create route opens project guidance for parent flag %s",
    async (enabled) => {
      const screen = renderScreen("/agentcore/gateway/create", {
        globalConfig: enabled ? IMPERATIVE_GLOBAL_CONFIG : DEFAULT_GLOBAL_CONFIG,
      });
      await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
      expect(screen.lastFrame()).toContain("agentcore add gateway --name MyGateway");
      expect(screen.lastFrame()).not.toContain("this command runs from the command line");
      await screen.press("escape");
      expect(screen.core.gateway.calls).toEqual([]);
      await waitForText(
        screen.lastFrame,
        enabled ? "manage AgentCore Gateways" : "the platform for production AI agents",
      );
      if (!enabled) {
        expect(menuEntries(screen.lastFrame()!).screens).not.toContain("gateway");
      }
    },
  );

  test.each(
    GROUPS.flatMap((group) =>
      ["create", "update", "delete"]
        .filter((mutation) => group !== "gateway" || mutation !== "create")
        .map((mutation) => `${group}/${mutation}`),
    ),
  )("disabled direct route %s cannot expose mutation help", async (path) => {
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
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });
});
