import { afterEach, describe, expect, test } from "bun:test";
import { cleanupScreens, menuEntries, renderScreen, waitForText } from "../../testing";

afterEach(cleanupScreens);
const GROUPS = ["gateway", "gateway/target", "gateway/connector", "gateway/rule"];

describe("Gateway menus", () => {
  test.each(GROUPS)("%s lists no create, update, or delete commands", async (group) => {
    const screen = renderScreen(`/agentcore/${group}`);
    await waitForText(screen.lastFrame, "type to choose a command");
    const entries = menuEntries(screen.lastFrame()!);
    const names = [...entries.screens, ...entries.cliOnly];
    expect(names).not.toContain("create");
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(entries.cliOnly).toEqual([]);
    expect(screen.core.gateway.calls).toEqual([]);
  });

  test.each(
    GROUPS.flatMap((group) =>
      ["create", "update", "delete"].map((mutation) => `${group}/${mutation}`),
    ),
  )("direct route %s cannot expose mutation help", async (path) => {
    const screen = renderScreen(`/agentcore/${path}`);
    await waitForText(() => screen.frames.join("\n"), "Usage:");
    expect(screen.frames.join("\n")).not.toContain("run it with:");
    expect(screen.frames.join("\n")).not.toContain(`agentcore ${path.replaceAll("/", " ")}`);
    expect(screen.core.gateway.calls).toEqual([]);
  });
});
