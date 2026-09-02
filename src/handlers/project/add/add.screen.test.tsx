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
} from "../../../testing";
import { renderTuiAt } from "../../../tui";
import { NotImplementedError } from "../../../errors";
import { compile, ValueContext } from "../../../router";
import { createRootHandler } from "../../index";

afterEach(cleanupScreens);

// addSubcommands reads the resources off the compiled Commander tree, so a
// `project add` resource added later is covered without editing this file.
function addSubcommands(): string[] {
  const root = compile(
    createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    }),
    ValueContext.EmptyContext(),
  );
  const project = root.commands.find((command) => command.name() === "project")!;
  const add = project.commands.find((command) => command.name() === "add")!;
  return add.commands.map((command) => command.name()).filter((name) => name !== "help");
}

// The resources with a wizard. Everything else still routes to the
// not-implemented screen and stays usable from the command line.
const WITH_SCREENS = [
  "memory",
  "gateway",
  "policy-engine",
  "config-bundle",
  "policy",
  "gateway-connector",
  "online-eval",
  "online-insight",
  "evaluator",
  "payment-manager",
];

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

describe("add resources without a wizard", () => {
  // renderTuiAt rather than renderScreen: ink-testing-library exposes no
  // waitUntilExit, so it cannot observe the rejection under test. Reading the
  // cases off the router also guards Root's hand-written ADD_COMMANDS — an
  // unrouted resource hits the catch-all, which resolves instead of rejecting.
  test.each(addSubcommands().filter((command) => !WITH_SCREENS.includes(command)))(
    "add %s tears down the TUI with NotImplementedError",
    async (command) => {
      const { streams } = ttyTestIO();

      const rendering = renderTuiAt(
        `/agentcore/project/add/${command}`,
        ValueContext.EmptyContext(),
        new TestCoreClient(),
        streams.io,
      );

      await expect(rendering).rejects.toThrow(NotImplementedError);
      await expect(rendering).rejects.toThrow(`'agentcore project add ${command}'`);
    },
  );

  test("the error names the command to run instead", async () => {
    const { streams } = ttyTestIO();

    const caught: unknown = await renderTuiAt(
      "/agentcore/project/add/harness",
      ValueContext.EmptyContext(),
      new TestCoreClient(),
      streams.io,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(NotImplementedError);
    expect((caught as NotImplementedError).message).toContain(
      "agentcore project add harness --help",
    );
  });
});
