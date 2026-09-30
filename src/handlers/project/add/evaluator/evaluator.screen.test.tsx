import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  createSilentLogger,
  menuEntries,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForText,
} from "../../../../testing";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createRootHandler } from "../../../index";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject } = createGatewayProjectTestHarness("add-evaluator-menu");

afterEach(cleanup);
afterEach(cleanupScreens);

const LEAVES = ["llm-as-a-judge", "code-based"];

describe("project add evaluator menu", () => {
  test("lists both evaluator wizards and esc returns to the add menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/evaluator");

    await waitForText(screen.lastFrame, "add a custom evaluator to the current project");
    const { screens, cliOnly } = menuEntries(screen.lastFrame()!);
    expect(screens).toEqual(LEAVES);
    expect(cliOnly).toEqual([]);
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test.each(LEAVES)("esc on the first %s step returns to the evaluator menu", async (leaf) => {
    await inProject();
    const screen = renderScreen(`/agentcore/add/evaluator/${leaf}`);

    await waitForText(screen.lastFrame, "what should this evaluator be called?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add a custom evaluator to the current project");
    screen.unmount();
  });
});

describe.each(LEAVES)("project add evaluator %s dispatch", (leaf) => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "evaluator", leaf, ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name");
  }

  test("a bare command in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "evaluator", leaf])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("required option");
  }, 10000);

  test.each<[string, () => AppIO, string[]]>([
    ["a bare command without a TTY", () => testIO().io, []],
    ["a user-supplied flag in a TTY", () => ttyTestIO().streams.io, ["--level", "SESSION"]],
    ["--json in a TTY", () => ttyTestIO().streams.io, ["--json"]],
  ])("%s stays headless", async (_label, io, args) => {
    await inProject();

    expectMissingName(await routeError(io(), args));
  });
});
