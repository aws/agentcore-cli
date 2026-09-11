import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  type RenderScreenResult,
} from "../../../../testing";
import { createRootHandler } from "../../../index";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-runtime-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

// selectTemplate moves the choice list onto a named template rather than
// pressing a fixed number of arrows, so adding or reordering a template does
// not silently point this test at a different one.
async function selectTemplate(r: RenderScreenResult, template: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // The trailing space keeps a name from matching a longer one that starts
    // with it — agent-python-strands against agent-python-strands-container.
    if (flatFrame(r.lastFrame).includes(`● ${template} `)) return;
    await r.press("down");
  }
  throw new Error(`template ${template} was never selected`);
}

// templateRows returns the choice list in the order it is drawn.
function templateRows(frame: string): string[] {
  return (
    frame
      .split("\n")
      .map((line) => line.replace(/[│┃|]/g, " ").replace(/\s+/g, " ").trim())
      // A radio row starts with its marker; the stepper's markers sit mid-line.
      .filter((line) => /^[●○] /.test(line))
  );
}

async function runtimeInSpec(projectRoot: string, name: string) {
  const spec = await projectSpec(projectRoot);
  return spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
}

describe("project add runtime wizard", () => {
  test("collects a name and a template, then writes the runtime", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("orders_agent");
    await r.press("return");

    // The default template is the one the flag path scaffolds without
    // --template, and it is the first row, so the step opens at the top of its
    // list rather than partway down it.
    await waitForText(r.lastFrame, "choose a template");
    expect(templateRows(r.lastFrame()!)[0]).toStartWith("● agent-python-minimal ");
    await r.press("return");

    await waitForText(r.lastFrame, "this runtime will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("runtime orders_agent");
    expect(review).toContain("template agent-python-minimal");
    await r.press("return");

    await waitForText(r.lastFrame, "added runtime 'orders_agent' to 'TestProject'");
    expect(r.lastFrame()).toContain("[enter] go back");

    expect(await runtimeInSpec(projectRoot, "orders_agent")).toMatchObject({
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/orders_agent",
      runtimeVersion: "PYTHON_3_14",
    });
    expect(await Bun.file(join(projectRoot, "app", "orders_agent", "main.py")).exists()).toBe(true);

    // Enter on the success panel returns to the add menu instead of tearing the
    // TUI down, so another resource can be added straight away.
    await r.press("return");
    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });

  test("scaffolds the template the user picks", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("packing_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a template");
    await selectTemplate(r, "agent-python-strands-container");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "build Container");
    await r.press("return");

    await waitForText(r.lastFrame, "added runtime 'packing_agent' to 'TestProject'");

    const runtime = await runtimeInSpec(projectRoot, "packing_agent");
    expect(runtime).toMatchObject({ build: "Container", codeLocation: "app/packing_agent" });
    // The wizard does not ask for a description; --description still sets one.
    expect(runtime.description).toBeUndefined();
    expect(await Bun.file(join(projectRoot, "app", "packing_agent", "Dockerfile")).exists()).toBe(
      true,
    );
    r.unmount();
  });

  test("a blank name is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("return");

    await waitForText(r.lastFrame, "Name is required");
    expect(r.lastFrame()).not.toContain("choose a template");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    // No enter: the name is checked while it is being typed, so the rule is
    // stated before the user has finished getting it wrong.
    await r.write("1agent");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });

  test("the name is held to the same length limit as --name", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    // 43 characters: one past what the flag path accepts, and what its own
    // test rejects there.
    await r.write("a".repeat(43));

    await waitForText(r.lastFrame, "Must be at most 42 characters");
    r.unmount();
  });

  test("a name that is only valid once trimmed is refused, not silently trimmed", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write(" orders_agent ");
    await r.press("return");

    // Still on the name step: the value the step would submit is the value it
    // checked, so a padded name cannot reach the project spec.
    await waitForText(r.lastFrame, "Must begin with a letter");
    expect(r.lastFrame()).not.toContain("choose a template");
    expect(await runtimeInSpec(projectRoot, " orders_agent ")).toBeUndefined();
    r.unmount();
  });

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `project add runtime`
// has to reach the wizard, and everything else has to stay headless.
describe("project add runtime dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  const MISSING_NAME = "required option '--name <name>' not specified";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "project", "add", "runtime", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add runtime in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "project", "add", "runtime"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The wizard never finishes on its own; Ctrl+C (re-sent until the app
    // reacts, slowly enough that repeats cannot coalesce into one chunk) closes
    // it and resolves the route cleanly. The headless branch would instead
    // reject with the missing --name usage error.
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

  test("bare add runtime without a TTY stays headless and reports the missing --name", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--description", "an agent"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("flag-driven add runtime still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "project",
      "add",
      "runtime",
      "--name",
      "flag_agent",
    ]);

    expect(await runtimeInSpec(projectRoot, "flag_agent")).toBeDefined();
  }, 10000);
});
