import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
} from "../../testing";
import { renderTuiAt } from "../../tui";
import { InvalidEnvironmentError, NotImplementedError } from "../../errors";
import { compile, ValueContext } from "../../router";
import { ExitCode } from "../../runnable";
import { createRootHandler } from "../index";

afterEach(cleanupScreens);

// projectSubcommands reads the project group's children off the compiled
// Commander tree, so tests driven by it cover any subcommand added later.
function projectSubcommands(): string[] {
  const root = compile(
    createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    }),
    ValueContext.EmptyContext(),
  );
  const project = root.commands.find((command) => command.name() === "project")!;
  // `help` is Commander's own, not one of ours.
  return project.commands.map((command) => command.name()).filter((name) => name !== "help");
}

describe("project menu", () => {
  test("lists every project subcommand", async () => {
    const r = renderScreen("/agentcore/project");

    await waitForText(r.lastFrame, "manage an AgentCore project");
    const frame = r.lastFrame()!;
    for (const command of projectSubcommands()) {
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
  // renderTuiAt rather than renderScreen: ink-testing-library exposes no
  // waitUntilExit, so it cannot observe the rejection under test.
  //
  // Reading the cases off the router also guards Root's hand-written
  // PROJECT_COMMANDS: an unrouted subcommand hits the catch-all, which resolves
  // instead of rejecting. Frames can't detect that — the catch-all exits before
  // painting, so it and this screen both render empty. `create`, `invoke` and
  // `add` are excluded because all three have real screens.
  test.each(
    projectSubcommands().filter((command) => !["create", "invoke", "add"].includes(command)),
  )("%s tears down the TUI with NotImplementedError", async (command) => {
    const { streams } = ttyTestIO();

    const rendering = renderTuiAt(
      `/agentcore/project/${command}`,
      ValueContext.EmptyContext(),
      new TestCoreClient(),
      streams.io,
    );

    await expect(rendering).rejects.toThrow(NotImplementedError);
    await expect(rendering).rejects.toThrow(`'agentcore project ${command}'`);
  });

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

describe("agentcore project (no subcommand)", () => {
  // Exercises the real CLI entrypoint; the screen tests mount a path directly
  // and so never caught the missing default handler.
  //
  // Asserts renderTui's TTY guard rather than a rendered frame: Ink only writes
  // frames incrementally when interactive (`!isInCi && isTTY`), so asserting on
  // frames here would pass locally and time out under CI. Reaching the guard at
  // all proves the group routed to the TUI — Commander help neither throws nor
  // touches stderr.
  test("routes to the TUI rather than printing Commander help", async () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });

    const caught: unknown = await root.route(["node", "agentcore", "project"]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(InvalidEnvironmentError);
    expect((caught as InvalidEnvironmentError).exitCode).toBe(ExitCode.USAGE);
    expect(io.stdout()).toBe("");
  });

  test("prints help instead of the TUI under --json", async () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });

    await root.route(["node", "agentcore", "project", "--json"]);

    expect(io.stdout()).toContain("Usage:");
    expect(io.stdout()).toContain("create");
  });
});
