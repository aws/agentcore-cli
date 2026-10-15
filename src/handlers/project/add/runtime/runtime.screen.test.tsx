import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
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
import { InputValidationError, InvalidEnvironmentError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-runtime-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

// selectChoice moves a choice list onto a named row rather than pressing a
// fixed number of arrows, so reordering the choices does not silently point a
// test at a different one.
async function selectChoice(r: RenderScreenResult, label: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (flatFrame(r.lastFrame).includes(`● ${label} `)) return;
    await r.press("down");
  }
  throw new Error(`choice ${label} was never selected`);
}

async function runtimeInSpec(projectRoot: string, name: string) {
  const spec = await projectSpec(projectRoot);
  return spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
}

describe("project add runtime wizard", () => {
  test("collects a name, a language, and a protocol, then writes the runtime docs", async () => {
    const projectRoot = await inProject();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const r = renderScreen("/agentcore/add/runtime", { queryClient });

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("orders_agent");
    await r.press("return");

    // Python and HTTP are the defaults, so enter twice keeps them.
    await waitForText(r.lastFrame, "which language will you write it in?");
    expect(flatFrame(r.lastFrame)).toContain("● python ");
    await r.press("return");
    await waitForText(r.lastFrame, "which protocol will it serve?");
    expect(flatFrame(r.lastFrame)).toContain("● HTTP ");
    await r.press("return");

    await waitForText(r.lastFrame, "this runtime will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("runtime orders_agent");
    expect(review).toContain("language Python");
    expect(review).toContain("protocol HTTP");
    expect(review).toContain("entrypoint main.py");
    await r.press("return");

    await waitForText(r.lastFrame, 'Added runtime "orders_agent" (Python, HTTP).');
    expect(r.lastFrame()).toContain("[enter] go back");

    expect(await runtimeInSpec(projectRoot, "orders_agent")).toEqual({
      name: "orders_agent",
      build: "CodeZip",
      runtimeVersion: "PYTHON_3_14",
      entrypoint: "main.py",
      codeLocation: "app/orders_agent",
      protocol: "HTTP",
    });
    const appDir = join(projectRoot, "app", "orders_agent");
    expect(await Bun.file(join(appDir, "README.md")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "AGENTS.md")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "main.py")).exists()).toBe(false);
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.runtimes.some((runtime) => runtime.name === "orders_agent"),
    ).toBe(true);

    // Enter on the success panel returns to the add menu instead of tearing the
    // TUI down, so another resource can be added straight away.
    await r.press("return");
    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });

  test("writes the language and protocol the user picks", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("tools");
    await r.press("return");

    await waitForText(r.lastFrame, "which language will you write it in?");
    await selectChoice(r, "typescript");
    await r.press("return");
    await waitForText(r.lastFrame, "which protocol will it serve?");
    await selectChoice(r, "MCP");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "entrypoint main.js");
    expect(flatFrame(r.lastFrame)).toContain("protocol MCP");
    await r.press("return");
    await waitForText(r.lastFrame, 'Added runtime "tools" (TypeScript, MCP).');

    expect(await runtimeInSpec(projectRoot, "tools")).toEqual({
      name: "tools",
      build: "CodeZip",
      runtimeVersion: "NODE_22",
      entrypoint: "main.js",
      codeLocation: "app/tools",
      protocol: "MCP",
    });
    const readme = await Bun.file(join(projectRoot, "app", "tools", "README.md")).text();
    expect(readme).toContain("runtime-mcp-protocol-contract.html");
    expect(readme).toContain("main.ts");
    r.unmount();
  });

  test("a blank name is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("return");

    await waitForText(r.lastFrame, "Name is required");
    expect(r.lastFrame()).not.toContain("which language will you write it in?");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    // No enter: the name is checked while it is being typed, so the rule is
    // stated before the user has finished getting it wrong.
    await r.write("1agent");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });

  test("accepts a 48-character name", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("a".repeat(48));
    await r.press("return");

    await waitForText(r.lastFrame, "which language will you write it in?");
    r.unmount();
  });

  test("rejects a name longer than 48 characters", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("a".repeat(49));

    await waitForText(r.lastFrame, "Must be at most 48 characters");
    r.unmount();
  });

  test("a name that is only valid once trimmed is refused, not silently trimmed", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write(" orders_agent ");
    await r.press("return");

    // Still on the name step: the value the step would submit is the value it
    // checked, so a padded name cannot reach the project spec.
    await waitForText(r.lastFrame, "Must begin with a letter");
    expect(r.lastFrame()).not.toContain("which language will you write it in?");
    expect(await runtimeInSpec(projectRoot, " orders_agent ")).toBeUndefined();
    r.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    // The name is taken, so addResource refuses it — the realistic failure, and
    // one the user can fix without starting over.
    await run(["add", "runtime", "--name", "orders_agent", "--language", "python"]);
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("orders_agent");
    await r.press("return");
    await waitForText(r.lastFrame, "which language will you write it in?");
    await r.press("return");
    await waitForText(r.lastFrame, "which protocol will it serve?");
    await r.press("return");
    await waitForText(r.lastFrame, "this runtime will be added to agentcore.json");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "a runtime with name 'orders_agent' already exists");
    // esc, not a dead TUI: the failure is reported inside the wizard, which then
    // returns to the form with every answer still in it.
    await r.press("escape");
    await waitForText(r.lastFrame, "this runtime will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("runtime orders_agent");

    // The refused add wrote nothing beyond the runtime that was already there.
    expect((await projectSpec(projectRoot)).runtimes).toHaveLength(2);
    r.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add runtime`
// has to reach the wizard, and everything else has to stay headless.
describe("project add runtime dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  const MISSING_NAME = "required option '--name' not specified";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "runtime", ...args])
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
      .route(["node", "agentcore", "add", "runtime"])
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

  test("bare project add routes to the resource menu", async () => {
    await inProject();
    const io = testIO();

    const error = await buildRoot(io.io)
      .route(["node", "agentcore", "add"])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect(io.stdout()).toBe("");
  });

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
      "add",
      "runtime",
      "--name",
      "flag_agent",
      "--language",
      "python",
    ]);

    expect(await runtimeInSpec(projectRoot, "flag_agent")).toBeDefined();
  }, 10000);
});
