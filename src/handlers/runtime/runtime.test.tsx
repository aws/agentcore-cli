import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";
import { TestGlobalConfigAccessor } from "../../testing/globalConfig";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// The shared E2E fixture Runtime has versions 1 and 2 plus DEFAULT and
// runtimeReadOnlyFixture endpoints. The account has multiple Runtimes for
// Runtime pagination. Page-two requests use the token returned by page one.
// Record with AWS_PROFILE=e2e-test RECORD=1 bun test src/handlers/runtime/runtime.test.tsx.
const FIXTURE_RUNTIME_ID = "agentcore_cli_runtime_read_only_fixture-wZ7V4Q6vhx";

// Log search pins a separate Runtime invocation and fixed window. Re-recording
// requires these events to remain within that log group's retention period.
const FIXTURE_LOG_RUNTIME_ID = "asdf_MyAgent-3s5axvBC6Q";
const FIXTURE_LOG_SESSION_ID = "67ebf93b-65e3-4127-9e13-483b239f256a";
const LOG_WINDOW_START = "2026-08-12T00:00:00Z";
const LOG_WINDOW_END = "2026-08-13T00:00:00Z";
const MISSING_RUNTIME_ID = "missing_runtime-0000000000";

const LOG_SEARCH_ARGS = [
  "runtime",
  "logs",
  "--id",
  FIXTURE_LOG_RUNTIME_ID,
  "--since",
  LOG_WINDOW_START,
  "--until",
  LOG_WINDOW_END,
  "--query",
  `"${FIXTURE_LOG_SESSION_ID}"`,
  "--limit",
  "1",
];

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);

  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
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

function testRuntimeCommand() {
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

describe("runtime command hierarchy", () => {
  test("registers the Runtime command hierarchy", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const runtime = root.children().find((child) => child.name() === "runtime");

    expect(runtime?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(runtime?.children().map((child) => child.name())).toEqual([
      "get",
      "list",
      "invoke",
      "shell",
      "version",
      "endpoint",
      "logs",
      "traces",
    ]);
    expect(
      runtime
        ?.children()
        .find((child) => child.name() === "traces")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["list", "get"]);
    expect(
      runtime
        ?.children()
        .find((child) => child.name() === "version")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["get", "list"]);
    expect(
      runtime
        ?.children()
        .find((child) => child.name() === "endpoint")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["get", "list"]);
  });

  test.each(["runtime", "runtime version", "runtime endpoint"])(
    "prints help for `%s --json` without an SDK call",
    async (command) => {
      const stdout = await run([...command.split(" "), "--json"]);

      expect(stdout).toContain(`Usage: agentcore ${command}`);
      expect(stdout).toContain("Commands:");
    },
  );
});

describe("runtime TUI dispatch", () => {
  test.each([
    ["get", ["runtime", "get"]],
    ["endpoint list", ["runtime", "endpoint", "list"]],
  ] as const)("opens the TUI for a bare Runtime %s leaf", async (_label, args) => {
    const { core, route } = testRuntimeCommand();

    await expect(route([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
    expect(core.runtime.calls).toEqual([]);
  });
});

describe("runtime read-only commands", () => {
  test("searches recorded Runtime logs through the real CLI path", async () => {
    const stdout = await run(LOG_SEARCH_ARGS);

    matchGolden(FIXTURES, "logs-search.golden.txt", stdout);
    expect(stdout).toContain(FIXTURE_LOG_SESSION_ID);
  });

  test("renders recorded Runtime logs as JSON Lines", async () => {
    const stdout = await run([...LOG_SEARCH_ARGS, "--json"]);

    matchGolden(FIXTURES, "logs-search-json.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      timestamp: "2026-08-12T17:23:12.053Z",
      message: expect.any(String),
    });
  });

  test("gets a Runtime whose ID exceeds the 48-character Runtime name limit", async () => {
    expect(FIXTURE_RUNTIME_ID.length).toBeGreaterThan(48);

    const stdout = await run(["runtime", "get", "--id", FIXTURE_RUNTIME_ID]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).agentRuntimeId).toBe(FIXTURE_RUNTIME_ID);
  });

  test("paginates Runtime list with --max-results and --next-token", async () => {
    const firstPage = await run(["runtime", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.agentRuntimes).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "runtime",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).agentRuntimes).toHaveLength(1);
  });

  test("gets a Runtime version using an ID exceeding the 48-character Runtime name limit", async () => {
    const stdout = await run([
      "runtime",
      "version",
      "get",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--version",
      "1",
    ]);

    matchGolden(FIXTURES, "version-get.golden.json", stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentRuntimeId).toBe(FIXTURE_RUNTIME_ID);
    expect(parsed.agentRuntimeVersion).toBe("1");
  });

  test("paginates Runtime version list with --max-results and --next-token", async () => {
    const firstPage = await run([
      "runtime",
      "version",
      "list",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--max-results",
      "1",
    ]);
    matchGolden(FIXTURES, "version-list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.agentRuntimes).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "runtime",
      "version",
      "list",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "version-list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).agentRuntimes).toHaveLength(1);
  });

  test("maps the endpoint qualifier using an ID exceeding the 48-character Runtime name limit", async () => {
    const stdout = await run([
      "runtime",
      "endpoint",
      "get",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--qualifier",
      "DEFAULT",
    ]);

    matchGolden(FIXTURES, "endpoint-get.golden.json", stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentRuntimeArn).toContain(FIXTURE_RUNTIME_ID);
    expect(parsed.name).toBe("DEFAULT");
  });

  test("paginates Runtime endpoint list with --max-results and --next-token", async () => {
    const firstPage = await run([
      "runtime",
      "endpoint",
      "list",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--max-results",
      "1",
    ]);
    matchGolden(FIXTURES, "endpoint-list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.runtimeEndpoints).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "runtime",
      "endpoint",
      "list",
      "--id",
      FIXTURE_RUNTIME_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "endpoint-list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).runtimeEndpoints).toHaveLength(1);
  });

  test.each([
    ["runtime get", ["runtime", "get"], /--id/],
    ["runtime version get", ["runtime", "version", "get"], /--id/],
    [
      "runtime version get --id <runtime-id>",
      ["runtime", "version", "get", "--id", FIXTURE_RUNTIME_ID],
      /--version/,
    ],
    ["runtime version list", ["runtime", "version", "list"], /--id/],
    ["runtime endpoint get", ["runtime", "endpoint", "get"], /--id/],
    [
      "runtime endpoint get --id <runtime-id>",
      ["runtime", "endpoint", "get", "--id", FIXTURE_RUNTIME_ID],
      /--qualifier/,
    ],
    ["runtime endpoint list", ["runtime", "endpoint", "list"], /--id/],
  ] as const)(
    "rejects a missing required selector for headless `%s`",
    async (_label, args, message) => {
      await expect(run([...args, "--json"])).rejects.toThrow(message);
    },
  );

  test.each([
    [
      "runtime version list",
      ["runtime", "version", "list", "--id", FIXTURE_RUNTIME_ID],
      "version-list-id-over-48.golden.json",
      "agentRuntimes",
    ],
    [
      "runtime endpoint list",
      ["runtime", "endpoint", "list", "--id", FIXTURE_RUNTIME_ID],
      "endpoint-list-id-over-48.golden.json",
      "runtimeEndpoints",
    ],
  ] as const)(
    "accepts a Runtime ID exceeding the 48-character Runtime name limit for `%s`",
    async (_label, args, golden, collection) => {
      const stdout = await run([...args]);

      matchGolden(FIXTURES, golden, stdout);
      expect(JSON.parse(stdout)[collection].length).toBeGreaterThan(0);
    },
  );

  test("propagates ResourceNotFoundException from Runtime get", async () => {
    await expect(run(["runtime", "get", "--id", MISSING_RUNTIME_ID])).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
