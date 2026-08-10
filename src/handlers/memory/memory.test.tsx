import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";
import { createGetMemoryHandler } from "./get";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// The e2e-test account holds two persistent fixture Memories:
// agentcore_cli_memory_read_only_fixture (get) and
// agentcore_cli_memory_read_only_fixture_second (needed for list pagination, >=2).
// Record with AWS_PROFILE=e2e-test RECORD=1 bun test src/handlers/memory/memory.test.tsx.
const FIXTURE_MEMORY_ID = "agentcore_cli_memory_read_only_fixture-QZMh466aPK";
const MISSING_MEMORY_ID = "missing_memory-0000000000";

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);

  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

function testMemoryCommand() {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
  };
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("memory command hierarchy", () => {
  test("registers the Memory read-only command hierarchy", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const memory = root.children().find((child) => child.name() === "memory");

    expect(memory?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(memory?.children().map((child) => child.name())).toEqual(["get", "list"]);
  });

  test("keeps an omitted get view undefined for empty-flag routing", () => {
    const get = createGetMemoryHandler(createFixtureCore());
    const view = get.flags().find((flag) => flag.name === "view");

    expect(view?.schema.parse(undefined)).toBeUndefined();
  });

  test("prints help for `memory --json` without an SDK call", async () => {
    const stdout = await run(["memory", "--json"]);

    expect(stdout).toContain("Usage: agentcore memory");
    expect(stdout).toContain("Commands:");
  });
});

describe("memory TUI dispatch", () => {
  test.each([
    ["get", ["memory", "get"]],
    ["list", ["memory", "list"]],
  ] as const)("opens the TUI for a bare Memory %s leaf", async (_label, args) => {
    const { core, route } = testMemoryCommand();

    await expect(route([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
    expect(core.memory.calls).toEqual([]);
  });
});

describe("memory read-only commands", () => {
  test("gets a Memory using the full view by default", async () => {
    const stdout = await run(["memory", "get", "--id", FIXTURE_MEMORY_ID]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).memory.id).toBe(FIXTURE_MEMORY_ID);
  });

  test("accepts the without_decryption view", async () => {
    const stdout = await run([
      "memory",
      "get",
      "--id",
      FIXTURE_MEMORY_ID,
      "--view",
      "without_decryption",
    ]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
  });

  test("paginates Memory list with --max-results and --next-token", async () => {
    const firstPage = await run(["memory", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.memories).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "memory",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).memories).toHaveLength(1);
  });

  test("rejects a missing Memory selector for headless get", async () => {
    await expect(run(["memory", "get", "--json"])).rejects.toThrow(/--id/);
  });

  test("rejects an unsupported response view", async () => {
    await expect(
      run(["memory", "get", "--id", FIXTURE_MEMORY_ID, "--view", "summary"]),
    ).rejects.toThrow(/Invalid value for option '--view'/);
  });

  test("propagates ResourceNotFoundException from Memory get", async () => {
    await expect(run(["memory", "get", "--id", MISSING_MEMORY_ID])).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
