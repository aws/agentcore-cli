import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  TestCoreClient,
  ttyTestIO,
} from "../../testing";
import { renderTuiAt } from "../../tui";
import { NotImplementedError } from "../../errors";
import { ValueContext } from "../../router";

afterEach(cleanupScreens);

// `project` used to be listed in the root menu with no route to match it, so
// selecting it fell through to the catch-all HelpScreen — which prints the
// launching command's help and exits, leaving the user with a blank frame and no
// TUI. It now has a menu, and its subcommands report that they have no screen
// yet rather than pretending to.

describe("project menu", () => {
  test("lists every project subcommand", async () => {
    const r = renderScreen("/agentcore/project");

    await waitForText(r.lastFrame, "manage an AgentCore project");
    const frame = r.lastFrame()!;
    for (const command of ["create", "add", "remove", "dev", "deploy", "status", "build"]) {
      expect(frame).toContain(command);
    }
    r.unmount();
  });

  test("is reachable from the root menu", async () => {
    const r = renderScreen("/agentcore");

    await waitForText(r.lastFrame, "manage an AgentCore project");
    await r.write("project");
    await waitForText(r.lastFrame, "❯ project");
    await r.press("return");

    // The project menu, not the blank frame the catch-all used to produce.
    await waitForText(r.lastFrame, "agentcore → project");
    expect(r.lastFrame()).toContain("create");
    r.unmount();
  });

  test("esc returns to the root menu", async () => {
    const r = renderScreen("/agentcore/project");

    await waitForText(r.lastFrame, "agentcore → project");
    await r.press("escape");

    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });
});

describe("project subcommands without a screen", () => {
  // Driven through renderTuiAt (the production mount path) rather than
  // renderScreen: the behavior under test is that Ink's exit(error) rejects the
  // promise the CLI awaits, which is what turns into an exit code and a message
  // on stderr. ink-testing-library does not expose waitUntilExit, so it cannot
  // observe this.
  test.each(["create", "add", "remove", "dev", "deploy", "status", "build"])(
    "%s tears down the TUI with NotImplementedError",
    async (command) => {
      const { streams } = ttyTestIO();

      const rendering = renderTuiAt(
        `/agentcore/project/${command}`,
        ValueContext.EmptyContext(),
        new TestCoreClient(),
        streams.io,
      );

      await expect(rendering).rejects.toThrow(NotImplementedError);
      await expect(rendering).rejects.toThrow(`'agentcore project ${command}'`);
    },
  );

  test("the error names the command to run instead", async () => {
    const { streams } = ttyTestIO();

    const caught: unknown = await renderTuiAt(
      "/agentcore/project/deploy",
      ValueContext.EmptyContext(),
      new TestCoreClient(),
      streams.io,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(NotImplementedError);
    const error = caught as NotImplementedError;
    expect(error.message).toContain("agentcore project deploy --help");
    // Surfaces as a plain CLI failure, not a crash.
    expect(error.exitCode).toBe(1);
  });
});
