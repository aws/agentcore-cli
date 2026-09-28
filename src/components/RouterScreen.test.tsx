import { test, expect, describe, afterEach } from "bun:test";
import {
  cleanupScreens,
  menuEntries,
  renderScreen,
  renderImperativeScreen,
  tick,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);

const PROJECT_WORKFLOW = [
  "create",
  "add",
  "remove",
  "dev",
  "build",
  "deploy",
  "status",
  "invoke",
  "log",
  "traces",
  "export",
  "eval",
];

// menuGroups reads a RouterScreen frame's option names in display order,
// grouped under the divider each follows (untitled for the leading group).
function menuGroups(frame: string): { title: string | undefined; names: string[] }[] {
  const groups: { title: string | undefined; names: string[] }[] = [];
  for (const line of frame.split("\n")) {
    const divider = /^── (.+?) ─/.exec(line);
    if (divider) {
      groups.push({ title: divider[1], names: [] });
      continue;
    }
    const option = /^\s{1,3}(?:❯ )?\s*([a-z][a-z0-9-]*)\s{2,}\S/.exec(line);
    if (!option) continue;
    if (groups.length === 0) groups.push({ title: undefined, names: [] });
    groups[groups.length - 1]!.names.push(option[1]!);
  }
  return groups;
}

// RouterScreen is the interactive command menu. These tests mount it through the
// real Root at a command path and drive it with key presses, asserting on the
// rendered frames — behavior a user would see, not internal state.

describe("menu rendering", () => {
  test("lists the current command's subcommands with their descriptions", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    const frame = r.lastFrame()!;
    const entries = menuEntries(frame);
    expect(entries.screens).toContain("create");
    expect(frame).toContain("eval");
    for (const family of ["harness", "identity", "runtime", "memory", "gateway", "payment"]) {
      expect([...entries.screens, ...entries.cliOnly]).not.toContain(family);
    }
    expect(frame).toContain("config");
    expect(frame).toContain("read/write global config values");
    r.unmount();
  });

  test("lists standalone commands in the root menu when enabled", async () => {
    const r = renderImperativeScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    const entries = menuEntries(r.lastFrame()!);
    expect(entries.screens).toEqual(
      expect.arrayContaining(["harness", "identity", "runtime", "memory", "gateway", "payment"]),
    );
    expect(entries.cliOnly).not.toContain("payment");
    r.unmount();
  });

  test("lists the resources alphabetically under a resources divider after the project commands", async () => {
    const r = renderImperativeScreen("/agentcore");
    await waitForText(r.lastFrame, "── resources");

    expect(menuGroups(r.lastFrame()!)).toEqual([
      { title: undefined, names: PROJECT_WORKFLOW },
      {
        title: "resources",
        names: ["gateway", "harness", "identity", "memory", "payment", "runtime"],
      },
      { title: "command line only", names: ["feedback", "config", "update"] },
    ]);
    r.unmount();
  });

  test("lists the same project workflow with no resources section when standalone commands are disabled", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    const frame = r.lastFrame()!;
    expect(frame).not.toContain("── resources");
    expect(menuGroups(frame)).toEqual([
      { title: undefined, names: PROJECT_WORKFLOW },
      { title: "command line only", names: ["feedback", "config", "update"] },
    ]);
    r.unmount();
  });

  test("selecting a listed command without a screen opens its help", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("dev");
    await waitForText(r.lastFrame, "❯ dev");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore dev [options]");
    r.unmount();
  });

  test("keeps the resources divider when filtering leaves a resource", async () => {
    const r = renderImperativeScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("harn");
    await waitForText(r.lastFrame, "❯ harness");
    const frame = r.lastFrame()!;
    expect(frame).toContain("── resources");
    expect(frame).not.toContain("── command line only");
    r.unmount();
  });

  test("filtering to the project workflow leaves no resources divider", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    await r.write("dep");
    await waitForText(r.lastFrame, "❯ deploy");
    expect(r.lastFrame()).not.toContain("── resources");
    r.unmount();
  });

  test("shows the command description in the header", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });

  test("renders the harness subcommands when mounted at the harness path", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    const frame = r.lastFrame()!;
    for (const sub of ["get", "list", "create", "update", "delete", "invoke", "exec"]) {
      expect(frame).toContain(sub);
    }
    r.unmount();
  });

  test("highlights the first option by default", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");
    // The focus caret marks the highlighted row; the first option is create.
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });
});

describe("filtering", () => {
  test("typing narrows the options to matches", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("cr"); // matches "create" only
    await waitForText(r.lastFrame, "❯ create");

    const frame = r.lastFrame()!;
    expect(frame).toContain("create");
    expect(frame).not.toContain("list");
    expect(frame).not.toContain("delete");
    r.unmount();
  });

  test("filtering is case-insensitive", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("LIST");
    await waitForText(r.lastFrame, "❯ list");
    r.unmount();
  });

  test("shows a no-matches message when nothing matches", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("zzz");
    await waitForText(r.lastFrame, "No matches");
    r.unmount();
  });
});

describe("navigation", () => {
  test.each(["harness", "runtime/endpoint"])(
    "an unavailable %s menu redirects to a working root menu",
    async (path) => {
      const r = renderScreen(`/agentcore/${path}`);
      await waitForText(r.lastFrame, "the platform for production AI agents");

      await r.write("eval");
      await r.press("return");
      await waitForText(r.lastFrame, "agentcore → eval");
      expect(r.lastFrame()).toContain("evaluator");
      r.unmount();
    },
  );

  test("down arrow moves the highlight to the next option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ add");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ remove");
    r.unmount();
  });

  test("up arrow does not move past the first option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("up");
    await tick(20);
    // Still on the first option.
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("enter navigates into the highlighted subcommand's screen", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("return");
    await waitForText(r.lastFrame, "name your project");
    r.unmount();
  });

  test("esc from a nested menu returns to the parent menu", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "agentcore → harness");

    await r.press("escape");
    // Back at the root menu (breadcrumb no longer includes harness).
    await waitForText(r.lastFrame, "the platform for production AI agents");
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("esc at the root menu is a no-op (no parent to go to)", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ create");

    await r.press("escape");
    await tick(20);
    expect(r.lastFrame()).toContain("❯ create");
    r.unmount();
  });

  test("footer shows the esc hint only when there is a parent menu", async () => {
    const root = renderScreen("/agentcore");
    await waitForText(root.lastFrame, "❯ create");
    expect(root.lastFrame()).not.toContain("[esc]");
    root.unmount();

    const nested = renderImperativeScreen("/agentcore/harness");
    await waitForText(nested.lastFrame, "agentcore → harness");
    expect(nested.lastFrame()).toContain("[esc] back");
    nested.unmount();
  });
});
