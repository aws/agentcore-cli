import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  compiledRootCommand,
  menuEntries,
} from "../../../testing";

afterEach(cleanupScreens);

// addSubcommands reads the resources off the compiled Commander tree, so a
// `project add` resource added later is covered without editing this file.
// `help` is Commander's own, not one of ours.
function addSubcommands(): string[] {
  const root = compiledRootCommand();
  const project = root.commands.find((command) => command.name() === "project")!;
  const add = project.commands.find((command) => command.name() === "add")!;
  return add.commands.map((command) => command.name()).filter((name) => name !== "help");
}

// The resources with a wizard. Everything else is listed below the menu's
// "command line only" divider and opens its help instead.
const WITH_SCREENS = ["runtime"];

describe("project add menu", () => {
  test("lists every add resource", async () => {
    const r = renderScreen("/agentcore/project/add");

    await waitForText(r.lastFrame, "add project resources");
    const frame = r.lastFrame()!;
    for (const command of addSubcommands()) {
      expect(frame).toContain(command);
    }
    r.unmount();
  });

  test("the resources with a wizard are listed above the divider", async () => {
    const r = renderScreen("/agentcore/project/add");

    await waitForText(r.lastFrame, "command line only");
    const { screens, cliOnly } = menuEntries(r.lastFrame()!);
    expect(screens.toSorted()).toEqual(WITH_SCREENS.toSorted());
    expect(cliOnly.toSorted()).toEqual(
      addSubcommands()
        .filter((command) => !WITH_SCREENS.includes(command))
        .toSorted(),
    );
    r.unmount();
  });

  test("is reachable from the project menu", async () => {
    const r = renderScreen("/agentcore/project");

    await waitForText(r.lastFrame, "agentcore → project");
    await r.write("add");
    await waitForText(r.lastFrame, "❯ add");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → project → add");
    r.unmount();
  });

  test("esc returns to the project menu", async () => {
    const r = renderScreen("/agentcore/project/add");

    await waitForText(r.lastFrame, "agentcore → project → add");
    await r.press("escape");

    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });
});
