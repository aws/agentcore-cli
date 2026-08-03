import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  Event,
  EventMetadataFilterExpression,
  GetEventOutput,
  ListEventsOutput,
} from "@aws-sdk/client-bedrock-agentcore";
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
const ENDPOINT = "https://agentcore.example.test";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// The e2e-test account holds two persistent fixture Memories:
// agentcore_cli_memory_read_only_fixture (get) and
// agentcore_cli_memory_read_only_fixture_second (needed for list pagination, >=2).
// Record with AWS_PROFILE=e2e-test RECORD=1 bun test src/handlers/memory/memory.test.tsx.
const FIXTURE_MEMORY_ID = "agentcore_cli_memory_read_only_fixture-QZMh466aPK";
const MISSING_MEMORY_ID = "missing_memory-0000000000";
const EVENT_MEMORY_ID = "memory-1";
const ACTOR_ID = "actor-1";
const SESSION_ID = "session-1";
const EVENT_ID = "event-1";

const event: Event = {
  memoryId: EVENT_MEMORY_ID,
  actorId: ACTOR_ID,
  sessionId: SESSION_ID,
  eventId: EVENT_ID,
  eventTimestamp: new Date("2026-08-03T12:00:00.000Z"),
  payload: [],
};

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);

  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

function testMemoryCommand(core = new TestCoreClient()) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
    stdout: () => io.stdout(),
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
    const event = memory?.children().find((child) => child.name() === "event");

    expect(memory?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(memory?.children().map((child) => child.name())).toEqual(["get", "list", "event"]);
    expect(event?.children().map((child) => child.name())).toEqual(["get", "list"]);
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

describe("memory event commands", () => {
  test("gets an event and renders the response unchanged", async () => {
    const response: GetEventOutput = { event };
    const core = new TestCoreClient();
    core.memory.setGetEventResponse(response);
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "event",
      "get",
      "--memory",
      EVENT_MEMORY_ID,
      "--actor-id",
      ACTOR_ID,
      "--session-id",
      SESSION_ID,
      "--event-id",
      EVENT_ID,
      "--endpoint-url",
      ENDPOINT,
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "getEvent",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            actorId: ACTOR_ID,
            sessionId: SESSION_ID,
            eventId: EVENT_ID,
          },
          { region: REGION, endpointUrl: ENDPOINT },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test("lists events with branch, metadata, payload, and pagination options", async () => {
    const metadataFilter: EventMetadataFilterExpression = {
      left: { metadataKey: "tenant" },
      operator: "EQUALS_TO",
      right: { metadataValue: { stringValue: "acme" } },
    };
    const response: ListEventsOutput = {
      events: [event],
      nextToken: "page-3",
    };
    const core = new TestCoreClient();
    core.memory.setListEventsResponse(response, "page-2");
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "event",
      "list",
      "--memory",
      EVENT_MEMORY_ID,
      "--actor-id",
      ACTOR_ID,
      "--session-id",
      SESSION_ID,
      "--include-payloads",
      "--branch",
      "feature",
      "--include-parent-branches",
      "--metadata-filters",
      JSON.stringify([metadataFilter]),
      "--max-results",
      "1",
      "--next-token",
      "page-2",
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listEvents",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            actorId: ACTOR_ID,
            sessionId: SESSION_ID,
            includePayloads: true,
            filter: {
              branch: {
                name: "feature",
                includeParentBranches: true,
              },
              eventMetadata: [metadataFilter],
            },
            maxResults: 1,
            nextToken: "page-2",
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test("rejects parent branch inclusion without a branch", async () => {
    const command = testMemoryCommand();

    await expect(
      command.route([
        "memory",
        "event",
        "list",
        "--memory",
        EVENT_MEMORY_ID,
        "--actor-id",
        ACTOR_ID,
        "--session-id",
        SESSION_ID,
        "--include-parent-branches",
      ]),
    ).rejects.toThrow("'--include-parent-branches' requires '--branch'");
    expect(command.core.memory.calls).toEqual([]);
  });

  test("rejects invalid metadata filter JSON", async () => {
    const command = testMemoryCommand();

    await expect(
      command.route([
        "memory",
        "event",
        "list",
        "--memory",
        EVENT_MEMORY_ID,
        "--actor-id",
        ACTOR_ID,
        "--session-id",
        SESSION_ID,
        "--metadata-filters",
        "{",
      ]),
    ).rejects.toThrow("Invalid JSON for option '--metadata-filters'");
    expect(command.core.memory.calls).toEqual([]);
  });

  test("rejects missing event selectors without entering the TUI", async () => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "event", "get"])).rejects.toThrow(
      "required option '--memory <memory>' not specified",
    );
    expect(command.core.memory.calls).toEqual([]);
  });
});
