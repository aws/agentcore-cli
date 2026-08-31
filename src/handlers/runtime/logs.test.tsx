import { describe, expect, test } from "bun:test";
import type { LogRecord } from "../../core/observability";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";
import type { Project } from "../project/types";

const REGION = "us-west-2";
const SINCE_MS = 1_709_391_000_000;
const UNTIL_MS = 1_709_394_600_000;

function logRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: new Date(SINCE_MS),
    message: "hello",
    source: {
      provider: "cloudwatch",
      resource: {
        kind: "runtime",
        id: "my_agent-AbC123XyZ9",
        qualifier: "DEFAULT",
      },
      logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
    },
    raw: { eventId: "event-1" },
    ...overrides,
  };
}

function testLogsCommand() {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    io,
    route: (args: string[]) => root.route(["bun", "agentcore", ...args, "--region", REGION]),
  };
}

describe("runtime logs", () => {
  test("maps Runtime identity and shared search flags into the core client", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logRecords = [
      logRecord({ message: "hello world\n" }),
      logRecord({
        timestamp: new Date(SINCE_MS + 1_000),
        message: "second line",
      }),
    ];

    await route([
      "runtime",
      "logs",
      "--id",
      "my_agent-AbC123XyZ9",
      "--qualifier",
      "blue",
      "--since",
      `${SINCE_MS}`,
      "--until",
      `${UNTIL_MS}`,
      "--level",
      "ERROR",
      "--query",
      "database",
      "--limit",
      "25",
    ]);

    expect(core.observability.calls).toHaveLength(1);
    expect(core.observability.calls[0]).toMatchObject({
      method: "searchLogs",
      args: [
        {
          kind: "runtime",
          id: "my_agent-AbC123XyZ9",
          qualifier: "blue",
        },
        {
          startTimeMs: SINCE_MS,
          endTimeMs: UNTIL_MS,
          filterPattern: "ERROR database",
          limit: 25,
        },
        { region: REGION, endpointUrl: undefined },
        expect.any(AbortSignal),
      ],
    });
    expect(io.stdout()).toBe(
      "2024-03-02T14:50:00.000Z  hello world\n" + "2024-03-02T14:50:01.000Z  second line",
    );
  });

  test("--json emits the generic LogRecord contract as JSON Lines", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logRecords = [
      logRecord({
        correlation: { traceId: "trace-1" },
        severity: "INFO",
      }),
    ];

    await route([
      "runtime",
      "logs",
      "--id",
      "my_agent-AbC123XyZ9",
      "--since",
      `${SINCE_MS}`,
      "--json",
    ]);

    expect(JSON.parse(io.stdout())).toEqual({
      timestamp: "2024-03-02T14:50:00.000Z",
      message: "hello",
      correlation: { traceId: "trace-1" },
      severity: "INFO",
      source: {
        provider: "cloudwatch",
        resource: {
          kind: "runtime",
          id: "my_agent-AbC123XyZ9",
          qualifier: "DEFAULT",
        },
        logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
      },
      raw: { eventId: "event-1" },
    });
  });

  test("tails by default and accepts an explicit --tail", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logRecords = [logRecord({ message: "tailed" })];

    await route(["runtime", "logs", "--id", "my_agent-AbC123XyZ9", "--tail"]);

    expect(core.observability.calls[0]).toMatchObject({
      method: "tailLogs",
      args: [
        { kind: "runtime", id: "my_agent-AbC123XyZ9" },
        { filterPattern: undefined },
        { region: REGION, endpointUrl: undefined },
        expect.any(AbortSignal),
      ],
    });
    expect(io.stderr()).toContain(
      "Streaming logs for runtime my_agent-AbC123XyZ9... (Ctrl+C to stop)",
    );
    expect(io.stdout()).toBe("2024-03-02T14:50:00.000Z  tailed");
  });

  test("rejects conflicting mode and time inputs", async () => {
    const { route } = testLogsCommand();

    await expect(
      route(["runtime", "logs", "--id", "runtime-1", "--tail", "--since", "1h"]),
    ).rejects.toThrow("--tail cannot be combined with --since or --until");

    await expect(
      route([
        "runtime",
        "logs",
        "--id",
        "runtime-1",
        "--since",
        `${UNTIL_MS}`,
        "--until",
        `${SINCE_MS}`,
      ]),
    ).rejects.toThrow("--since must resolve to a time before --until");
  });

  test("requires a Runtime ID", async () => {
    const { core, route } = testLogsCommand();
    core.projectManager.resolve = async () => undefined;

    await expect(route(["runtime", "logs", "--since", `${SINCE_MS}`])).rejects.toThrow(
      "required option '--id <id>' not specified",
    );
  });

  test("auto-resolves the project's deployed Runtime through the project manager", async () => {
    const { core, route } = testLogsCommand();
    const project = { name: "Proj", rootPath: "/proj", spec: {} } as unknown as Project;
    core.projectManager.resolve = async () => project;
    core.projectManager.resolveDeployedResources = async () => ({
      resources: [{ resourceType: "runtime", name: "agent", id: "deployed-runtime" }],
      target: {
        name: "default",
        account: "111122223333",
        region: "eu-west-1",
      },
    });

    await route(["runtime", "logs", "--since", `${SINCE_MS}`]);

    const call = core.observability.calls[0]!;
    expect(call.method).toBe("searchLogs");
    expect(call.args[0]).toEqual({ kind: "runtime", id: "deployed-runtime" });
    expect(call.args[2]).toEqual({ region: "eu-west-1", endpointUrl: undefined });
  });

  test("anchors the default one-hour window to a historical --until", async () => {
    const { core, route } = testLogsCommand();

    await route(["runtime", "logs", "--id", "runtime-1", "--until", `${UNTIL_MS}`]);

    expect(core.observability.calls[0]!.args[1]).toMatchObject({
      startTimeMs: UNTIL_MS - 3_600_000,
      endTimeMs: UNTIL_MS,
    });
  });
});
