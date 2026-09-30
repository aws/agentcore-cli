import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  compiledRootCommand,
  hasCliDivider,
  menuEntries,
  inProjectContext,
} from "../../../testing";

afterEach(cleanupScreens);

// addSubcommands reads the resources off the compiled Commander tree, so a
// An `add` resource added later is covered without editing this file.
// `help` is Commander's own, not one of ours.
function addSubcommands(): string[] {
  const root = compiledRootCommand();
  const add = root.commands.find((command) => command.name() === "add")!;
  return add.commands.map((command) => command.name()).filter((name) => name !== "help");
}

describe("project add menu", () => {
  test("lists every add resource", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "add project resources");
    const frame = r.lastFrame()!;
    for (const command of addSubcommands()) {
      expect(frame).toContain(command);
    }
    r.unmount();
  });

  // A resource without a screen would be listed below a divider and open its
  // help instead; every add resource has a wizard, so there is no divider.
  test("every resource opens a wizard, so nothing is listed below a divider", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "add project resources");
    const { screens, cliOnly } = menuEntries(r.lastFrame()!);
    expect(screens.toSorted()).toEqual(addSubcommands().toSorted());
    expect(cliOnly).toEqual([]);
    expect(hasCliDivider(r.lastFrame()!)).toBe(false);
    r.unmount();
  });

  test("is reachable from the root menu", async () => {
    const r = renderScreen("/agentcore", { withContext: inProjectContext });

    await waitForText(r.lastFrame, "the platform for production AI agents");
    await r.write("add");
    await waitForText(r.lastFrame, "❯ add");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → add");
    r.unmount();
  });

  test("esc returns to the root menu", async () => {
    const r = renderScreen("/agentcore/add");

    await waitForText(r.lastFrame, "agentcore → add");
    await r.press("escape");

    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });
});
