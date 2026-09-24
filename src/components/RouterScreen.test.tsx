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
      expect.arrayContaining(["harness", "identity", "runtime", "memory", "gateway"]),
    );
    expect(entries.cliOnly).toContain("payment");
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
});
