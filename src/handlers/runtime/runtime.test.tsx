import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import { createSilentLogger, fixtureFactories, matchGolden, testIO } from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// To re-record, update these IDs to real us-west-2 resources: LONG_RUNTIME_ID
// needs version 1 and DEFAULT, the version target needs at least two versions,
// the endpoint target needs at least two endpoints, and the account needs at
// least two Runtimes. Page-two requests always use the token returned by page one.
const LONG_RUNTIME_ID = "harness_tf_acc_test_3496516139353111995-U17dI2Favb";
const PAGINATED_VERSION_RUNTIME_ID = "starter_toolkit_agent-58HnLF6qC3";
const PAGINATED_ENDPOINT_RUNTIME_ID = "weather_agent-Q1UyBZG08k";
const MISSING_RUNTIME_ID = "missing_runtime-0000000000";

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  return new CoreClient(createControlClient, createDataClient, createIamClient);
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("runtime command hierarchy", () => {
  test("registers only the approved control-plane branches", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
    });
    const runtime = root.children().find((child) => child.name() === "runtime");

    expect(runtime?.children().map((child) => child.name())).toEqual([
      "get",
      "list",
      "version",
      "endpoint",
    ]);
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
    "prints AppIO-backed help for bare `%s` without an SDK call",
    async (command) => {
      const stdout = await run(command.split(" "));

      expect(stdout).toContain(`Usage: agentcore ${command}`);
      expect(stdout).toContain("Commands:");
    },
  );
});

describe("runtime control reads", () => {
  test("gets a service-valid long Runtime ID through the real Core", async () => {
    const stdout = await run(["runtime", "get", "--id", LONG_RUNTIME_ID]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).agentRuntimeId).toBe(LONG_RUNTIME_ID);
  });

  test("lists two Runtime pages with Harness pagination names", async () => {
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

  test("gets a Runtime version for a service-valid long Runtime ID", async () => {
    const stdout = await run([
      "runtime",
      "version",
      "get",
      "--id",
      LONG_RUNTIME_ID,
      "--version",
      "1",
    ]);

    matchGolden(FIXTURES, "version-get.golden.json", stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentRuntimeId).toBe(LONG_RUNTIME_ID);
    expect(parsed.agentRuntimeVersion).toBe("1");
  });

  test("lists two Runtime version pages", async () => {
    const firstPage = await run([
      "runtime",
      "version",
      "list",
      "--id",
      PAGINATED_VERSION_RUNTIME_ID,
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
      PAGINATED_VERSION_RUNTIME_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "version-list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).agentRuntimes).toHaveLength(1);
  });

  test("maps the endpoint qualifier for a service-valid long Runtime ID", async () => {
    const stdout = await run([
      "runtime",
      "endpoint",
      "get",
      "--id",
      LONG_RUNTIME_ID,
      "--qualifier",
      "DEFAULT",
    ]);

    matchGolden(FIXTURES, "endpoint-get.golden.json", stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentRuntimeArn).toContain(LONG_RUNTIME_ID);
    expect(parsed.name).toBe("DEFAULT");
  });

  test("lists two Runtime endpoint pages", async () => {
    const firstPage = await run([
      "runtime",
      "endpoint",
      "list",
      "--id",
      PAGINATED_ENDPOINT_RUNTIME_ID,
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
      PAGINATED_ENDPOINT_RUNTIME_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "endpoint-list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).runtimeEndpoints).toHaveLength(1);
  });

  test.each([
    [["runtime", "get"], /--id/],
    [["runtime", "version", "get"], /--id/],
    [["runtime", "version", "get", "--id", LONG_RUNTIME_ID], /--version/],
    [["runtime", "version", "list"], /--id/],
    [["runtime", "endpoint", "get"], /--id/],
    [["runtime", "endpoint", "get", "--id", LONG_RUNTIME_ID], /--qualifier/],
    [["runtime", "endpoint", "list"], /--id/],
  ] as const)("rejects a missing required selector for `%s`", async (args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [
      ["runtime", "version", "list", "--id", LONG_RUNTIME_ID],
      "long-version-list.golden.json",
      "agentRuntimes",
    ],
    [
      ["runtime", "endpoint", "list", "--id", LONG_RUNTIME_ID],
      "long-endpoint-list.golden.json",
      "runtimeEndpoints",
    ],
  ] as const)(
    "accepts a service-valid long Runtime ID for `%s`",
    async (args, golden, collection) => {
      const stdout = await run([...args]);

      matchGolden(FIXTURES, golden, stdout);
      expect(JSON.parse(stdout)[collection].length).toBeGreaterThan(0);
    },
  );

  test("propagates a recorded Runtime service error", async () => {
    await expect(run(["runtime", "get", "--id", MISSING_RUNTIME_ID])).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
