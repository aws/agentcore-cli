import { test, expect, describe, afterEach } from "bun:test";
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
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-memory-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

// toggleStrategy walks the checkbox list to a named strategy and checks it,
// rather than pressing a fixed number of arrows: a strategy added to the schema
// later cannot silently point this test at a different one. It returns the
// cursor to the top first, so it works wherever the cursor was left.
async function toggleStrategy(r: RenderScreenResult, strategy: string): Promise<void> {
  for (let i = 0; i < 10; i++) await r.press("up");
  for (let i = 0; i < 10; i++) {
    if (flatFrame(r.lastFrame).includes(`❯ [ ] ${strategy} `)) {
      await r.write(" ");
      return;
    }
    await r.press("down");
  }
  throw new Error(`strategy ${strategy} was never reached`);
}

async function memoryInSpec(projectRoot: string, name: string) {
  const spec = await projectSpec(projectRoot);
  return spec.memories.find((candidate: { name: string }) => candidate.name === name);
}

describe("project add memory wizard", () => {
  test("collects a name, strategies and retention, then writes the memory", async () => {
    const projectRoot = await inProject();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const r = renderScreen("/agentcore/add/memory", { queryClient });

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("orders_memory");
    await r.press("return");

    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await toggleStrategy(r, "SEMANTIC");
    await toggleStrategy(r, "EPISODIC");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.press("return");

    await waitForText(r.lastFrame, "this Memory will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("memory orders_memory");
    expect(review).toContain("strategies SEMANTIC, EPISODIC");
    expect(review).toContain("event retention 30 days");
    await r.press("return");

    await waitForText(r.lastFrame, "added memory 'orders_memory' to 'TestProject'");
    expect(r.lastFrame()).toContain("[enter] go back");

    // The strategies carry the same namespaces `--strategies SEMANTIC,EPISODIC`
    // would have written, EPISODIC included with its reflection namespaces.
    expect(await memoryInSpec(projectRoot, "orders_memory")).toMatchObject({
      eventExpiryDuration: 30,
      strategies: [
        { type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] },
        {
          type: "EPISODIC",
          namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
          reflectionNamespaceTemplates: ["/episodes/{actorId}"],
        },
      ],
    });
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.memories.some((memory) => memory.name === "orders_memory"),
    ).toBe(true);

    await r.press("return");
    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  }, 15000);

  test("selecting no strategy adds a memory that only keeps raw events", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("events_only");
    await r.press("return");

    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "strategies (none) · short-term memory only");
    await r.press("return");

    await waitForText(r.lastFrame, "added memory 'events_only' to 'TestProject'");
    const memory = await memoryInSpec(projectRoot, "events_only");
    expect(memory.strategies).toEqual([]);
    // The wizard does not ask for a description; --description still sets one.
    expect(memory.description).toBeUndefined();
    r.unmount();
  }, 15000);

  test("the strategies chosen are ordered as the list draws them", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("ordered_memory");
    await r.press("return");

    // Checked bottom-up; the memory still reads top-down.
    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await toggleStrategy(r, "USER_PREFERENCE");
    await toggleStrategy(r, "SEMANTIC");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "strategies SEMANTIC, USER_PREFERENCE");
    await r.press("return");

    await waitForText(r.lastFrame, "added memory 'ordered_memory' to 'TestProject'");
    expect(
      (await memoryInSpec(projectRoot, "ordered_memory")).strategies.map(
        (strategy: { type: string }) => strategy.type,
      ),
    ).toEqual(["SEMANTIC", "USER_PREFERENCE"]);
    r.unmount();
  }, 15000);

  test("a blank name is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.press("return");

    await waitForText(r.lastFrame, "Name is required");
    expect(r.lastFrame()).not.toContain("what should be extracted");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("1memory");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });

  test("retention outside the service's range keeps the step", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("short_memory");
    await r.press("return");
    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    // The prefilled 30 typed out to 3000, past the longest retention allowed.
    await r.write("00");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "<=365");
    expect(r.lastFrame()).toContain("how long should raw events be kept?");
    r.unmount();
  });

  test("retention that is not a number keeps the step", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("odd_memory");
    await r.press("return");
    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await r.press("return");

    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.write("d");
    await r.press("return");

    await waitForText(r.lastFrame, "Event retention must be a whole number");
    r.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    // The name is taken, so addResource refuses it — the realistic failure, and
    // one the user can fix without starting over.
    await run(["add", "memory", "--name", "orders_memory"]);
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.write("orders_memory");
    await r.press("return");
    await waitForText(r.lastFrame, "what should be extracted into long-term memory?");
    await r.press("return");
    await waitForText(r.lastFrame, "how long should raw events be kept?");
    await r.press("return");
    await waitForText(r.lastFrame, "this Memory will be added to agentcore.json");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "a memory with name 'orders_memory' already exists");
    await r.press("escape");
    await waitForText(r.lastFrame, "this Memory will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("memory orders_memory");

    expect((await projectSpec(projectRoot)).memories).toHaveLength(1);
    r.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/add/memory");

    await waitForText(r.lastFrame, "what should this Memory be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add memory` has
// to reach the wizard, and everything else has to stay headless.
describe("project add memory dispatch", () => {
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
      .route(["node", "agentcore", "add", "memory", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add memory in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "memory"])
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

  test("bare add memory without a TTY stays headless and reports the missing --name", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--description", "order history"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("flag-driven add memory still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "memory",
      "--name",
      "flag_memory",
    ]);

    expect(await memoryInSpec(projectRoot, "flag_memory")).toBeDefined();
  }, 10000);
});
