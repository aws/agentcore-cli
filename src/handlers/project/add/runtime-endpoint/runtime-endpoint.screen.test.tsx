import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  initProject,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../testing";
import { createRootHandler } from "../../../index";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { projectSpec, writeProjectSpec } from "../gateway-test-support";
import { endpointNameSchema } from "./screen";

type Endpoints = Record<string, { version: number; description?: string }>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));
afterEach(cleanupScreens);

function buildRoot(io: AppIO) {
  return createRootHandler(new TestCoreClient(), {
    io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
}

async function run(args: string[]) {
  const io = testIO();
  await buildRoot(io.io).route(["node", "agentcore", ...args]);
  return io;
}

// A minimal runtime is enough for an endpoint's parent; scaffolding a real one
// would install dependencies the endpoint path never touches.
function runtimeSpec(name: string, endpoints?: Endpoints) {
  return {
    name,
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: `app/${name}`,
    runtimeVersion: "PYTHON_3_13",
    ...(endpoints ? { endpoints } : {}),
  };
}

// withRuntimes starts a project with exactly the given runtimes — none, when
// called bare — so the first step's list is known.
async function withRuntimes(...runtimes: ReturnType<typeof runtimeSpec>[]): Promise<string> {
  const { projectRoot, cleanup } = await initProject({
    prefix: "agentcore-add-runtime-endpoint-wizard-",
  });
  cleanups.push(cleanup);
  const spec = await projectSpec(projectRoot);
  await writeProjectSpec(projectRoot, { ...spec, runtimes });
  return projectRoot;
}

async function endpointsOf(projectRoot: string, runtime: string): Promise<Endpoints | undefined> {
  const spec = await projectSpec(projectRoot);
  const runtimes = spec.runtimes as Array<{ name: string; endpoints?: Endpoints }>;
  return runtimes.find((candidate) => candidate.name === runtime)?.endpoints;
}

// reachDetailsStep confirms the first runtime and names the endpoint, leaving
// the wizard on the version step with its prefilled 1.
async function reachDetailsStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "which Runtime should this endpoint belong to?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should this endpoint be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "which Runtime version does it point to?");
}

describe("runtime-endpoint wizard helpers", () => {
  test("endpointNameSchema applies the name rule and refuses a name the Runtime already has", () => {
    const schema = endpointNameSchema(runtimeSpec("agent", { prod: { version: 1 } }) as never);
    expect(schema.safeParse("staging").success).toBe(true);
    expect(schema.safeParse("9lives").success).toBe(false);
    const taken = schema.safeParse("prod");
    expect(taken.success).toBe(false);
    expect(taken.error?.issues[0]?.message).toBe(
      "an endpoint named 'prod' already exists on runtime 'agent'",
    );
    // Without a runtime to check against, only the name rule applies.
    expect(endpointNameSchema(undefined).safeParse("prod").success).toBe(true);
  });
});

describe("project add runtime-endpoint wizard", () => {
  test("adds the same endpoint as the flags, on the Runtime picked from the list", async () => {
    const projectRoot = await withRuntimes(
      runtimeSpec("agent", { prod: { version: 1 } }),
      runtimeSpec("worker"),
    );
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    // Each Runtime shows the endpoints it already has.
    await waitForText(screen.lastFrame, "which Runtime should this endpoint belong to?");
    expect(screen.lastFrame()).toContain("❯ ● agent");
    expect(screen.lastFrame()).toContain("endpoint: prod");
    expect(screen.lastFrame()).toContain("no endpoints yet");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● worker");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this endpoint be called?");
    await screen.write("staging");
    await screen.press("return");

    // Version and description share a step; the version is prefilled with 1.
    await waitForText(screen.lastFrame, "which Runtime version does it point to?");
    expect(screen.lastFrame()).toContain("Version");
    expect(screen.lastFrame()).toContain("Description");
    await screen.press("backspace");
    await screen.write("3");
    await screen.press("return");
    await screen.write("Production traffic");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this endpoint will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("runtime worker");
    expect(review).toContain("endpoint staging");
    expect(review).toContain("version 3");
    expect(review).toContain("description Production traffic");
    await screen.press("return");

    await waitForFlatText(
      screen.lastFrame,
      "added runtime endpoint 'staging' (version 3) to runtime 'worker' in 'TestProject'",
    );
    expect(screen.lastFrame()).toContain("agentcore deploy");
    expect(await endpointsOf(projectRoot, "worker")).toEqual({
      staging: { version: 3, description: "Production traffic" },
    });
    expect(await endpointsOf(projectRoot, "agent")).toEqual({ prod: { version: 1 } });

    // The flags, given the same answers, write the same endpoint.
    await run([
      "add",
      "runtime-endpoint",
      "--runtime",
      "agent",
      "--name",
      "staging",
      "--version",
      "3",
      "--description",
      "Production traffic",
    ]);
    expect((await endpointsOf(projectRoot, "agent"))?.staging).toEqual(
      (await endpointsOf(projectRoot, "worker"))?.staging,
    );
    screen.unmount();
  });

  test("version defaults to 1 and the description is optional", async () => {
    const projectRoot = await withRuntimes(runtimeSpec("agent"));
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await reachDetailsStep(screen, "staging");
    await screen.press("return");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this endpoint will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("version 1");
    expect(review).toContain("description (none)");
    await screen.press("return");

    await waitForFlatText(
      screen.lastFrame,
      "added runtime endpoint 'staging' (version 1) to runtime 'agent' in 'TestProject'",
    );
    expect(await endpointsOf(projectRoot, "agent")).toEqual({ staging: { version: 1 } });
    screen.unmount();
  });

  test("a name the chosen Runtime already has is refused as it is typed", async () => {
    await withRuntimes(runtimeSpec("agent", { prod: { version: 2 } }));
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await waitForText(screen.lastFrame, "which Runtime should this endpoint belong to?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what should this endpoint be called?");
    await screen.write("prod");
    await waitForText(
      screen.lastFrame,
      "an endpoint named 'prod' already exists on runtime 'agent'",
    );
    await screen.press("return");
    expect(screen.lastFrame()).toContain("what should this endpoint be called?");

    // Any other well-formed name goes through.
    await screen.press("backspace");
    await screen.write("uction");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime version does it point to?");
    screen.unmount();
  });

  test("the version must be a whole number of at least 1", async () => {
    await withRuntimes(runtimeSpec("agent"));
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await reachDetailsStep(screen, "staging");
    await screen.press("backspace");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Version is required");

    await screen.write("0");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Version must be 1 or higher");

    await screen.press("backspace");
    await screen.write("v2");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Version must be a whole number");

    await screen.press("backspace");
    await screen.press("backspace");
    await screen.write("2");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this endpoint will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("version 2");
    screen.unmount();
  });

  test("without a Runtime the first step says what to add and esc returns to the menu", async () => {
    await withRuntimes();
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await waitForText(screen.lastFrame, "no Runtimes in this project");
    expect(screen.lastFrame()).toContain("agentcore add runtime");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await withRuntimes(runtimeSpec("agent"));
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await reachDetailsStep(screen, "prod");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this endpoint will be added to agentcore.json");

    // The name was free when typed; it is taken by the time the review submits.
    await run([
      "add",
      "runtime-endpoint",
      "--runtime",
      "agent",
      "--name",
      "prod",
      "--version",
      "4",
    ]);
    await screen.press("return");

    await waitForFlatText(
      screen.lastFrame,
      "a runtime-endpoint named 'prod' already exists on runtime 'agent'",
    );
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this endpoint will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("endpoint prod");

    expect(await endpointsOf(projectRoot, "agent")).toEqual({ prod: { version: 4 } });
    screen.unmount();
  });

  test("esc on the first step returns to the add menu", async () => {
    await withRuntimes(runtimeSpec("agent"));
    const screen = renderScreen("/agentcore/add/runtime-endpoint");

    await waitForText(screen.lastFrame, "which Runtime should this endpoint belong to?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

describe("project add runtime-endpoint dispatch", () => {
  const MISSING_RUNTIME = "required option '--runtime' not specified";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "runtime-endpoint", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add runtime-endpoint in a TTY session opens the wizard", async () => {
    await withRuntimes(runtimeSpec("agent"));
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "runtime-endpoint"])
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

  test("bare add runtime-endpoint without a TTY stays headless and reports the missing --runtime", async () => {
    await withRuntimes(runtimeSpec("agent"));

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_RUNTIME);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await withRuntimes(runtimeSpec("agent"));

    const error = await routeError(ttyTestIO().streams.io, ["--name", "prod"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_RUNTIME);
  });

  test("--json stays headless even in a TTY", async () => {
    await withRuntimes(runtimeSpec("agent"));

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_RUNTIME);
  });

  test("flag-driven add runtime-endpoint still runs headless in a TTY session", async () => {
    const projectRoot = await withRuntimes(runtimeSpec("agent"));
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "runtime-endpoint",
      "--runtime",
      "agent",
      "--name",
      "prod",
    ]);

    expect(await endpointsOf(projectRoot, "agent")).toEqual({ prod: { version: 1 } });
  });
});
