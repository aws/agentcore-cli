import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  ActorSummary,
  Event,
  EventMetadataFilterExpression,
  GetEventOutput,
  GetMemoryRecordOutput,
  ListActorsOutput,
  ListEventsOutput,
  ListMemoryRecordsOutput,
  ListSessionsOutput,
  MemoryMetadataFilterExpression,
  MemoryRecord,
  MemoryRecordSummary,
  SessionSummary,
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
const RECORD_ID = "record-1";

const actorSummary: ActorSummary = {
  actorId: ACTOR_ID,
};

const sessionSummary: SessionSummary = {
  actorId: ACTOR_ID,
  sessionId: SESSION_ID,
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
};

const event: Event = {
  memoryId: EVENT_MEMORY_ID,
  actorId: ACTOR_ID,
  sessionId: SESSION_ID,
  eventId: EVENT_ID,
  eventTimestamp: new Date("2026-08-03T12:00:00.000Z"),
  payload: [],
};

const memoryRecord: MemoryRecord = {
  memoryRecordId: RECORD_ID,
  content: { text: "Customer prefers email notifications." },
  memoryStrategyId: "strategy-1",
  namespaces: ["/customers/acme"],
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
};
const memoryRecordSummary: MemoryRecordSummary = memoryRecord;

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
    const record = memory?.children().find((child) => child.name() === "record");
    const actor = memory?.children().find((child) => child.name() === "actor");
    const session = memory?.children().find((child) => child.name() === "session");

    expect(memory?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(memory?.children().map((child) => child.name())).toEqual([
      "get",
      "list",
      "event",
      "record",
      "actor",
      "session",
    ]);
    expect(event?.children().map((child) => child.name())).toEqual(["get", "list"]);
    expect(record?.children().map((child) => child.name())).toEqual(["get", "list"]);
    expect(actor?.children().map((child) => child.name())).toEqual(["list"]);
    expect(session?.children().map((child) => child.name())).toEqual(["list"]);

    const memorySelectors = [
      memory?.children().find((child) => child.name() === "get"),
      ...[event, record, actor, session].flatMap((group) => group?.children() ?? []),
    ];
    for (const command of memorySelectors) {
      const flags = command?.flags().map((flag) => flag.name);
      expect(flags).toContain("id");
      expect(flags).not.toContain("memory");
    }
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
    ["event get", ["memory", "event", "get"]],
    ["event list", ["memory", "event", "list"]],
    ["record get", ["memory", "record", "get"]],
    ["record list", ["memory", "record", "list"]],
    ["actor list", ["memory", "actor", "list"]],
    ["session list", ["memory", "session", "list"]],
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
      "--id",
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
      "--id",
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
        "--id",
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
        "--id",
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

  test.each([
    ["memory", ["--json"], "--id <id>"],
    ["actor", ["--id", EVENT_MEMORY_ID, "--json"], "--actor-id <actor-id>"],
    [
      "session",
      ["--id", EVENT_MEMORY_ID, "--actor-id", ACTOR_ID, "--json"],
      "--session-id <session-id>",
    ],
    [
      "event",
      ["--id", EVENT_MEMORY_ID, "--actor-id", ACTOR_ID, "--session-id", SESSION_ID, "--json"],
      "--event-id <event-id>",
    ],
  ] as const)("rejects a missing %s selector for event get", async (_name, flags, expected) => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "event", "get", ...flags])).rejects.toThrow(expected);
    expect(command.core.memory.calls).toEqual([]);
  });

  test.each([
    ["memory", ["--json"], "--id <id>"],
    ["actor", ["--id", EVENT_MEMORY_ID, "--json"], "--actor-id <actor-id>"],
    [
      "session",
      ["--id", EVENT_MEMORY_ID, "--actor-id", ACTOR_ID, "--json"],
      "--session-id <session-id>",
    ],
  ] as const)("rejects a missing %s selector for event list", async (_name, flags, expected) => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "event", "list", ...flags])).rejects.toThrow(expected);
    expect(command.core.memory.calls).toEqual([]);
  });

  test.each([
    ["a non-array", "{}"],
    [
      "an invalid expression member",
      JSON.stringify([
        {
          left: { metadataKey: "tenant" },
          operator: "EQUALS_TO",
          right: { metadataValue: { numberValue: 1 } },
        },
      ]),
    ],
  ])("rejects %s in event metadata filters", async (_name, metadataFilters) => {
    const command = testMemoryCommand();

    await expect(
      command.route([
        "memory",
        "event",
        "list",
        "--id",
        EVENT_MEMORY_ID,
        "--actor-id",
        ACTOR_ID,
        "--session-id",
        SESSION_ID,
        "--metadata-filters",
        metadataFilters,
      ]),
    ).rejects.toThrow("Invalid value for option '--metadata-filters'");
    expect(command.core.memory.calls).toEqual([]);
  });
});

describe("memory actor commands", () => {
  test("lists actors with pagination options", async () => {
    const response: ListActorsOutput = {
      actorSummaries: [actorSummary],
      nextToken: "page-3",
    };
    const core = new TestCoreClient();
    core.memory.setListActorsResponse(response, "page-2");
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "actor",
      "list",
      "--id",
      EVENT_MEMORY_ID,
      "--max-results",
      "1",
      "--next-token",
      "page-2",
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listActors",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            maxResults: 1,
            nextToken: "page-2",
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test("rejects a missing Memory selector for actor list", async () => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "actor", "list", "--json"])).rejects.toThrow("--id <id>");
    expect(command.core.memory.calls).toEqual([]);
  });
});

describe("memory session commands", () => {
  test("lists an actor's sessions with pagination options", async () => {
    const response: ListSessionsOutput = {
      sessionSummaries: [sessionSummary],
      nextToken: "page-3",
    };
    const core = new TestCoreClient();
    core.memory.setListSessionsResponse(response, "page-2");
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "session",
      "list",
      "--id",
      EVENT_MEMORY_ID,
      "--actor-id",
      ACTOR_ID,
      "--max-results",
      "1",
      "--next-token",
      "page-2",
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listSessions",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            actorId: ACTOR_ID,
            maxResults: 1,
            nextToken: "page-2",
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test.each([
    ["memory", ["--json"], "--id <id>"],
    ["actor", ["--id", EVENT_MEMORY_ID, "--json"], "--actor-id <actor-id>"],
  ] as const)("rejects a missing %s selector for session list", async (_name, flags, expected) => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "session", "list", ...flags])).rejects.toThrow(expected);
    expect(command.core.memory.calls).toEqual([]);
  });
});

describe("memory record commands", () => {
  test("gets a record and renders the response unchanged", async () => {
    const response: GetMemoryRecordOutput = { memoryRecord };
    const core = new TestCoreClient();
    core.memory.setGetMemoryRecordResponse(response);
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "record",
      "get",
      "--id",
      EVENT_MEMORY_ID,
      "--record-id",
      RECORD_ID,
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "getMemoryRecord",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            memoryRecordId: RECORD_ID,
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test.each([
    ["memory", ["--json"], "--id <id>"],
    ["record", ["--id", EVENT_MEMORY_ID, "--json"], "--record-id <record-id>"],
  ] as const)("rejects a missing %s selector for record get", async (_name, flags, expected) => {
    const command = testMemoryCommand();

    await expect(command.route(["memory", "record", "get", ...flags])).rejects.toThrow(expected);
    expect(command.core.memory.calls).toEqual([]);
  });

  test("lists records with namespace, metadata, strategy, and pagination options", async () => {
    const metadataFilter: MemoryMetadataFilterExpression = {
      left: { metadataKey: "tenant" },
      operator: "EQUALS_TO",
      right: { metadataValue: { stringValue: "acme" } },
    };
    const response: ListMemoryRecordsOutput = {
      memoryRecordSummaries: [memoryRecordSummary],
      nextToken: "page-3",
    };
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse(response, "page-2");
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "record",
      "list",
      "--id",
      EVENT_MEMORY_ID,
      "--namespace",
      "/customers/acme",
      "--strategy-id",
      "strategy-1",
      "--metadata-filters",
      JSON.stringify([metadataFilter]),
      "--max-results",
      "1",
      "--next-token",
      "page-2",
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listMemoryRecords",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            namespace: "/customers/acme",
            namespacePath: undefined,
            memoryStrategyId: "strategy-1",
            metadataFilters: [metadataFilter],
            maxResults: 1,
            nextToken: "page-2",
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test("lists records by namespace hierarchy", async () => {
    const response: ListMemoryRecordsOutput = {
      memoryRecordSummaries: [memoryRecordSummary],
    };
    const core = new TestCoreClient();
    core.memory.setListMemoryRecordsResponse(response);
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "record",
      "list",
      "--id",
      EVENT_MEMORY_ID,
      "--namespace-path",
      "/customers/acme/*",
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listMemoryRecords",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            namespace: undefined,
            namespacePath: "/customers/acme/*",
            memoryStrategyId: undefined,
            metadataFilters: undefined,
            maxResults: undefined,
            nextToken: undefined,
          },
          { region: REGION },
        ],
      },
    ]);
    expect(JSON.parse(command.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
  });

  test("converts ISO datetime metadata filters to SDK Dates", async () => {
    const timestamp = "2026-08-04T16:33:58-04:00";
    const core = new TestCoreClient();
    const command = testMemoryCommand(core);

    await command.route([
      "memory",
      "record",
      "list",
      "--id",
      EVENT_MEMORY_ID,
      "--namespace",
      "/customers/acme",
      "--metadata-filters",
      JSON.stringify([
        {
          left: { metadataKey: "createdAt" },
          operator: "EQUALS_TO",
          right: { metadataValue: { dateTimeValue: timestamp } },
        },
      ]),
    ]);

    expect(core.memory.calls).toEqual([
      {
        method: "listMemoryRecords",
        args: [
          {
            memoryId: EVENT_MEMORY_ID,
            namespace: "/customers/acme",
            namespacePath: undefined,
            memoryStrategyId: undefined,
            metadataFilters: [
              {
                left: { metadataKey: "createdAt" },
                operator: "EQUALS_TO",
                right: { metadataValue: { dateTimeValue: new Date(timestamp) } },
              },
            ],
            maxResults: undefined,
            nextToken: undefined,
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("rejects a missing Memory selector for record list", async () => {
    const command = testMemoryCommand();

    await expect(
      command.route(["memory", "record", "list", "--namespace", "/customers/acme", "--json"]),
    ).rejects.toThrow("--id <id>");
    expect(command.core.memory.calls).toEqual([]);
  });

  test.each([
    ["neither", []],
    ["both", ["--namespace", "/customers/acme", "--namespace-path", "/customers/acme/*"]],
  ] as const)("rejects %s namespace selector", async (_case, selectors) => {
    const command = testMemoryCommand();

    await expect(
      command.route(["memory", "record", "list", "--id", EVENT_MEMORY_ID, ...selectors]),
    ).rejects.toThrow("exactly one of '--namespace' or '--namespace-path' must be specified");
    expect(command.core.memory.calls).toEqual([]);
  });

  test("rejects invalid record metadata filter JSON", async () => {
    const command = testMemoryCommand();

    await expect(
      command.route([
        "memory",
        "record",
        "list",
        "--id",
        EVENT_MEMORY_ID,
        "--namespace",
        "/customers/acme",
        "--metadata-filters",
        "{",
      ]),
    ).rejects.toThrow("Invalid JSON for option '--metadata-filters'");
    expect(command.core.memory.calls).toEqual([]);
  });

  test.each([
    ["a non-array", "{}"],
    [
      "an invalid expression member",
      JSON.stringify([
        {
          left: { metadataKey: "tenant" },
          operator: "EQUALS_TO",
          right: { metadataValue: { booleanValue: true } },
        },
      ]),
    ],
    [
      "a null datetime",
      JSON.stringify([
        {
          left: { metadataKey: "createdAt" },
          operator: "EQUALS_TO",
          right: { metadataValue: { dateTimeValue: null } },
        },
      ]),
    ],
    [
      "a numeric datetime",
      JSON.stringify([
        {
          left: { metadataKey: "createdAt" },
          operator: "EQUALS_TO",
          right: { metadataValue: { dateTimeValue: 0 } },
        },
      ]),
    ],
    [
      "a malformed datetime",
      JSON.stringify([
        {
          left: { metadataKey: "createdAt" },
          operator: "EQUALS_TO",
          right: { metadataValue: { dateTimeValue: "not-a-date" } },
        },
      ]),
    ],
  ])("rejects %s in record metadata filters", async (_name, metadataFilters) => {
    const command = testMemoryCommand();

    await expect(
      command.route([
        "memory",
        "record",
        "list",
        "--id",
        EVENT_MEMORY_ID,
        "--namespace",
        "/customers/acme",
        "--metadata-filters",
        metadataFilters,
      ]),
    ).rejects.toThrow("Invalid value for option '--metadata-filters'");
    expect(command.core.memory.calls).toEqual([]);
  });
});
