import { describe, expect, test } from "bun:test";
import {
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  ResourceNotFoundException,
  StartLiveTailCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type StartLiveTailResponseStream,
} from "@aws-sdk/client-cloudwatch-logs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudWatchQueryError,
  InputValidationError,
  ProjectStateError,
  ResourceNotFoundError,
  ResultTruncationError,
} from "../errors";
import type { ReadWriteJson } from "../io";
import type { Project } from "../handlers/project/types";
import type { AwsClients } from "./types";
import {
  ObservabilityClient,
  parseTimeString,
  runInsightsQuery,
  runtimeLogGroup,
  sanitizeQueryValue,
  type DescribeStackOutputs,
} from "./observability";

describe("runtimeLogGroup", () => {
  test("derives the fixed per-runtime path keyed by runtime id and endpoint", () => {
    expect(runtimeLogGroup("my_agent-AbC123XyZ9", "DEFAULT")).toBe(
      "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
    );
  });
});

describe("sanitizeQueryValue", () => {
  test("strips single quotes so values cannot escape a quoted Insights literal", () => {
    expect(sanitizeQueryValue("abc'| drop '123")).toBe("abc| drop 123");
    expect(sanitizeQueryValue("clean-id")).toBe("clean-id");
  });
});

describe("parseTimeString", () => {
  const NOW = 1_700_000_000_000;
  const now = () => NOW;

  test('parses "now" as the current time', () => {
    expect(parseTimeString("now", now)).toBe(NOW);
  });

  test("parses relative durations for every unit as that long ago", () => {
    expect(parseTimeString("30s", now)).toBe(NOW - 30_000);
    expect(parseTimeString("5m", now)).toBe(NOW - 5 * 60_000);
    expect(parseTimeString("1h", now)).toBe(NOW - 3_600_000);
    expect(parseTimeString("2d", now)).toBe(NOW - 2 * 86_400_000);
  });

  test("parses epoch milliseconds (13+ digits) literally", () => {
    expect(parseTimeString("1709391000000", now)).toBe(1_709_391_000_000);
  });

  test("parses ISO 8601 timestamps", () => {
    expect(parseTimeString("2026-03-02T14:30:00Z", now)).toBe(Date.parse("2026-03-02T14:30:00Z"));
  });

  test("trims surrounding whitespace", () => {
    expect(parseTimeString("  15m ", now)).toBe(NOW - 15 * 60_000);
  });

  test("rejects empty input with a typed error", () => {
    expect(() => parseTimeString("   ", now)).toThrow(InputValidationError);
    expect(() => parseTimeString("", now)).toThrow("Time string cannot be empty");
  });

  test("rejects garbage with a typed error naming the accepted forms", () => {
    expect(() => parseTimeString("yesterday-ish", now)).toThrow(InputValidationError);
    expect(() => parseTimeString("5x", now)).toThrow(
      'Invalid time string: "5x". Use relative durations (5m, 1h, 2d), ISO 8601, epoch ms, or "now".',
    );
  });
});

type Send = (command: unknown) => Promise<unknown>;

function fakeLogs(send: Send): CloudWatchLogsClient {
  return { send } as unknown as CloudWatchLogsClient;
}

function row(field: string, value: string) {
  return [{ field, value }];
}

describe("runInsightsQuery", () => {
  test("starts the query, waits for completion, and drains every result page", async () => {
    // Poll phase sees Complete on the first read; the drain phase then re-reads
    // page one and follows nextToken to page two.
    const logs = fakeLogs(async (command) => {
      if (command instanceof StartQueryCommand) {
        expect(command.input).toEqual({
          logGroupNames: ["/aws/group-a", "/aws/group-b"],
          queryString: "fields @message",
          startTime: 100,
          endTime: 200,
        });
        return { queryId: "q-1" };
      }
      expect(command).toBeInstanceOf(GetQueryResultsCommand);
      const input = (command as GetQueryResultsCommand).input;
      expect(input.queryId).toBe("q-1");
      if (input.nextToken === "page-2") {
        return { status: "Complete", results: [row("@message", "second")] };
      }
      return {
        status: "Complete",
        results: [row("@message", "first")],
        nextToken: "page-2",
      };
    });

    const rows = await runInsightsQuery(
      logs,
      ["/aws/group-a", "/aws/group-b"],
      "fields @message",
      100,
      200,
    );
    expect(rows).toEqual([row("@message", "first"), row("@message", "second")]);
  });

  test("throws a typed error when the query reaches a terminal failure state", async () => {
    const logs = fakeLogs(async (command) => {
      if (command instanceof StartQueryCommand) return { queryId: "q-2" };
      return { status: "Failed" };
    });

    await expect(runInsightsQuery(logs, ["/aws/g"], "q", 0, 1)).rejects.toThrow(
      CloudWatchQueryError,
    );
    await expect(runInsightsQuery(logs, ["/aws/g"], "q", 0, 1)).rejects.toThrow(
      "CloudWatch Logs Insights query failed",
    );
  });

  test("fails loudly with the default truncation error when the row ceiling is hit", async () => {
    const logs = fakeLogs(async (command) => {
      if (command instanceof StartQueryCommand) return { queryId: "q-3" };
      return { status: "Complete", results: [row("@message", "a"), row("@message", "b")] };
    });

    await expect(
      runInsightsQuery(logs, ["/aws/g"], "q", 0, 1, {
        maxRows: 2,
        buildError: (maxRows) => new ResultTruncationError(`hit ceiling ${maxRows}`),
      }),
    ).rejects.toThrow("hit ceiling 2");
  });

  test("lets the caller supply a domain-specific row-ceiling error", async () => {
    const logs = fakeLogs(async (command) => {
      if (command instanceof StartQueryCommand) return { queryId: "q-4" };
      return { status: "Complete", results: [row("@message", "a")] };
    });

    await expect(
      runInsightsQuery(logs, ["/aws/g"], "q", 0, 1, {
        maxRows: 1,
        buildError: () => new InputValidationError("narrow the scope"),
      }),
    ).rejects.toThrow(InputValidationError);
  });
});

const OPTIONS = { region: "us-east-1" };

function clientWith(logs: CloudWatchLogsClient, describeStackOutputs?: DescribeStackOutputs) {
  const clients = { logs: () => logs } as unknown as AwsClients;
  const readJson: ReadWriteJson = {
    read: async (filePath, schema) =>
      schema.parse(JSON.parse(await Bun.file(filePath).text())) as never,
    write: async () => {
      throw new Error("not implemented");
    },
  } as ReadWriteJson;
  return new ObservabilityClient(clients, { readJson, describeStackOutputs });
}

function fakeProject(rootPath: string, name = "My_Project"): Project {
  return { name, rootPath, spec: {} } as unknown as Project;
}

function projectWithTargets(
  targets: { name: string; account: string; region: string }[] | undefined,
): Project {
  const root = mkdtempSync(join(tmpdir(), "obs-test-"));
  if (targets) {
    mkdirSync(join(root, "agentcore"), { recursive: true });
    writeFileSync(join(root, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  }
  return fakeProject(root);
}

const TARGETS = [{ name: "default", account: "111122223333", region: "us-east-2" }];

describe("ObservabilityClient.resolveDeployedRuntime", () => {
  const noLogs = fakeLogs(async () => {
    throw new Error("unexpected CloudWatch call");
  });

  test("resolves the single deployed runtime from the target stack's outputs", async () => {
    const described: { stackName?: string; region?: string } = {};
    const client = clientWith(noLogs, async (stackName, region) => {
      described.stackName = stackName;
      described.region = region;
      return [
        { OutputKey: "StackNameOutput", OutputValue: "AgentCore-My-Project-default" },
        {
          OutputKey: "ApplicationAgentHelloWorldRuntimeArnOutput0DF4BB9A",
          OutputValue: "arn:aws:bedrock-agentcore:us-east-2:1:runtime/hello_world-AbC",
        },
        {
          OutputKey: "ApplicationAgentHelloWorldRuntimeIdOutput1CCED486",
          OutputValue: "hello_world-AbC123XyZ9",
        },
      ];
    });

    const resolved = await client.resolveDeployedRuntime(projectWithTargets(TARGETS), "default");

    // The stack name mirrors the vended CDK app: underscores sanitized to hyphens.
    expect(described).toEqual({ stackName: "AgentCore-My-Project-default", region: "us-east-2" });
    expect(resolved).toEqual({
      runtimeId: "hello_world-AbC123XyZ9",
      region: "us-east-2",
      stackName: "AgentCore-My-Project-default",
      targetName: "default",
    });
  });

  test("lists the candidates when several runtimes are deployed", async () => {
    const client = clientWith(noLogs, async () => [
      { OutputKey: "ApplicationAgentOneRuntimeIdOutputAAAAAAAA", OutputValue: "one-AAAA" },
      { OutputKey: "ApplicationAgentTwoRuntimeIdOutputBBBBBBBB", OutputValue: "two-BBBB" },
    ]);

    await expect(
      client.resolveDeployedRuntime(projectWithTargets(TARGETS), "default"),
    ).rejects.toThrow("choose one with --id: one-AAAA, two-BBBB");
  });

  test("fails with deploy guidance when the stack does not exist", async () => {
    const client = clientWith(noLogs, async () => undefined);

    await expect(
      client.resolveDeployedRuntime(projectWithTargets(TARGETS), "default"),
    ).rejects.toThrow(
      "Stack 'AgentCore-My-Project-default' is not deployed in us-east-2. " +
        "Run 'agentcore project deploy' first, or pass --id <runtimeId>.",
    );
  });

  test("fails when the stack exports no runtime ids", async () => {
    const client = clientWith(noLogs, async () => [
      { OutputKey: "StackNameOutput", OutputValue: "AgentCore-My-Project-default" },
    ]);

    await expect(
      client.resolveDeployedRuntime(projectWithTargets(TARGETS), "default"),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("fails when the named target is not configured", async () => {
    const client = clientWith(noLogs, async () => []);

    await expect(
      client.resolveDeployedRuntime(projectWithTargets(TARGETS), "production"),
    ).rejects.toThrow("has no deployment target named 'production'");
  });

  test("fails when the project has no aws-targets.json", async () => {
    const client = clientWith(noLogs, async () => []);

    await expect(
      client.resolveDeployedRuntime(projectWithTargets(undefined), "default"),
    ).rejects.toThrow(ProjectStateError);
  });
});

describe("ObservabilityClient.searchRuntimeLogs", () => {
  const SEARCH = {
    runtimeId: "my_agent-AbC123XyZ9",
    startTimeMs: 1_000,
    endTimeMs: 2_000,
  };

  async function collect(events: AsyncGenerator<{ timestamp: number; message: string }>) {
    const out: { timestamp: number; message: string }[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  test("paginates FilterLogEvents to completion, oldest to newest", async () => {
    const inputs: unknown[] = [];
    const logs = fakeLogs(async (command) => {
      expect(command).toBeInstanceOf(FilterLogEventsCommand);
      const input = (command as FilterLogEventsCommand).input;
      inputs.push(input);
      if (input.nextToken === "page-2") {
        return { events: [{ timestamp: 3, message: "three" }] };
      }
      return {
        events: [
          { timestamp: 1, message: "one" },
          { timestamp: 2, message: "two" },
        ],
        nextToken: "page-2",
      };
    });

    const events = await collect(clientWith(logs).searchRuntimeLogs(SEARCH, OPTIONS));

    expect(events).toEqual([
      { timestamp: 1, message: "one" },
      { timestamp: 2, message: "two" },
      { timestamp: 3, message: "three" },
    ]);
    expect(inputs[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
      startTime: 1_000,
      endTime: 2_000,
    });
    expect(inputs[1]).toMatchObject({ nextToken: "page-2" });
  });

  test("caps yielded events at limit and requests no more than needed", async () => {
    const limits: (number | undefined)[] = [];
    const logs = fakeLogs(async (command) => {
      const input = (command as FilterLogEventsCommand).input;
      limits.push(input.limit);
      if (input.nextToken === "page-2") {
        return {
          events: [
            { timestamp: 3, message: "three" },
            { timestamp: 4, message: "four" },
          ],
        };
      }
      return {
        events: [
          { timestamp: 1, message: "one" },
          { timestamp: 2, message: "two" },
        ],
        nextToken: "page-2",
      };
    });

    const events = await collect(
      clientWith(logs).searchRuntimeLogs({ ...SEARCH, limit: 3 }, OPTIONS),
    );

    expect(events.map((event) => event.message)).toEqual(["one", "two", "three"]);
    expect(limits).toEqual([3, 1]);
  });

  test("passes the filter pattern through to FilterLogEvents", async () => {
    const logs = fakeLogs(async (command) => {
      expect((command as FilterLogEventsCommand).input.filterPattern).toBe("ERROR database");
      return { events: [] };
    });

    await collect(
      clientWith(logs).searchRuntimeLogs({ ...SEARCH, filterPattern: "ERROR database" }, OPTIONS),
    );
  });

  test("translates a missing log group into invoked-yet guidance", async () => {
    const logs = fakeLogs(async () => {
      throw new ResourceNotFoundException({
        message: "The specified log group does not exist.",
        $metadata: {},
      });
    });

    await expect(collect(clientWith(logs).searchRuntimeLogs(SEARCH, OPTIONS))).rejects.toThrow(
      "No logs found for runtime 'my_agent-AbC123XyZ9': log group " +
        "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT does not exist. " +
        "Has the runtime been invoked yet?",
    );
  });
});

describe("ObservabilityClient.streamRuntimeLogs", () => {
  const STREAM = { runtimeId: "my_agent-AbC123XyZ9" };
  const LOG_GROUP = "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT";
  const GROUP_ARN = `arn:aws:logs:us-east-1:111122223333:log-group:${LOG_GROUP}`;

  type LiveTailEvent = Partial<StartLiveTailResponseStream>;

  function liveTailLogs(
    sessions: (LiveTailEvent[] | Error)[],
    groups: { logGroupName?: string; logGroupArn?: string; arn?: string }[] = [
      { logGroupName: LOG_GROUP, logGroupArn: GROUP_ARN },
    ],
  ) {
    const starts: unknown[] = [];
    const logs = fakeLogs(async (command) => {
      if (command instanceof DescribeLogGroupsCommand) {
        expect(command.input.logGroupNamePrefix).toBe(LOG_GROUP);
        return { logGroups: groups };
      }
      expect(command).toBeInstanceOf(StartLiveTailCommand);
      starts.push((command as StartLiveTailCommand).input);
      const session = sessions[starts.length - 1] ?? [];
      return {
        responseStream: (async function* () {
          if (session instanceof Error) throw session;
          yield* session as StartLiveTailResponseStream[];
        })(),
      };
    });
    return { logs, starts };
  }

  function update(...messages: string[]): LiveTailEvent {
    return {
      sessionUpdate: {
        sessionResults: messages.map((message, i) => ({ timestamp: 1_000 + i, message })),
      },
    };
  }

  async function collect(client: ObservabilityClient, signal: AbortSignal) {
    const out: string[] = [];
    for await (const event of client.streamRuntimeLogs(STREAM, OPTIONS, signal)) {
      out.push(event.message);
    }
    return out;
  }

  test("yields live-tail session updates and stops when the stream ends normally", async () => {
    const { logs, starts } = liveTailLogs([[update("one", "two"), update("three")]]);

    const messages = await collect(clientWith(logs), new AbortController().signal);

    expect(messages).toEqual(["one", "two", "three"]);
    expect(starts).toEqual([{ logGroupIdentifiers: [GROUP_ARN] }]);
  });

  test("reconnects when the session reports a timeout event", async () => {
    const { logs, starts } = liveTailLogs([
      [update("one"), { SessionTimeoutException: { name: "SessionTimeoutException" } } as never],
      [update("two")],
    ]);

    const messages = await collect(clientWith(logs), new AbortController().signal);

    expect(messages).toEqual(["one", "two"]);
    expect(starts).toHaveLength(2);
  });

  test("reconnects when the stream throws a session timeout", async () => {
    const timeout = Object.assign(new Error("session timed out"), {
      name: "SessionTimeoutException",
    });
    const { logs, starts } = liveTailLogs([timeout, [update("after-reconnect")]]);

    const messages = await collect(clientWith(logs), new AbortController().signal);

    expect(messages).toEqual(["after-reconnect"]);
    expect(starts).toHaveLength(2);
  });

  test("propagates non-timeout stream errors", async () => {
    const { logs } = liveTailLogs([new Error("stream exploded")]);

    await expect(collect(clientWith(logs), new AbortController().signal)).rejects.toThrow(
      "stream exploded",
    );
  });

  test("returns cleanly when aborted mid-session", async () => {
    const controller = new AbortController();
    const { logs, starts } = liveTailLogs([
      [update("one"), { SessionTimeoutException: { name: "SessionTimeoutException" } } as never],
    ]);

    const messages: string[] = [];
    for await (const event of clientWith(logs).streamRuntimeLogs(
      STREAM,
      OPTIONS,
      controller.signal,
    )) {
      messages.push(event.message);
      controller.abort();
    }

    // The timeout after the abort must not trigger a reconnect.
    expect(messages).toEqual(["one"]);
    expect(starts).toHaveLength(1);
  });

  test("passes the filter pattern to the live tail", async () => {
    const { logs, starts } = liveTailLogs([[]]);

    for await (const _ of clientWith(logs).streamRuntimeLogs(
      { ...STREAM, filterPattern: "ERROR" },
      OPTIONS,
      new AbortController().signal,
    )) {
      // drain
    }

    expect(starts).toEqual([{ logGroupIdentifiers: [GROUP_ARN], logEventFilterPattern: "ERROR" }]);
  });

  test("strips the legacy ARN's trailing :* when the modern field is absent", async () => {
    const { logs, starts } = liveTailLogs(
      [[]],
      [{ logGroupName: LOG_GROUP, arn: `${GROUP_ARN}:*` }],
    );

    await collect(clientWith(logs), new AbortController().signal);

    expect(starts).toEqual([{ logGroupIdentifiers: [GROUP_ARN] }]);
  });

  test("fails with invoked-yet guidance when the log group does not exist", async () => {
    const { logs } = liveTailLogs([[]], []);

    await expect(collect(clientWith(logs), new AbortController().signal)).rejects.toThrow(
      "Has the runtime been invoked yet?",
    );
  });
});

// insightsLogs fakes the StartQuery/GetQueryResults protocol: every query
// completes immediately with `results`, and each StartQuery input is recorded.
function insightsLogs(results: { field: string; value: string }[][]) {
  const queries: {
    logGroupNames?: string[];
    queryString?: string;
    startTime?: number;
    endTime?: number;
  }[] = [];
  const logs = fakeLogs(async (command) => {
    if (command instanceof StartQueryCommand) {
      queries.push(command.input);
      return { queryId: "q-traces" };
    }
    expect(command).toBeInstanceOf(GetQueryResultsCommand);
    return { status: "Complete", results };
  });
  return { logs, queries };
}

describe("ObservabilityClient.listRuntimeTraces", () => {
  const INPUT = {
    runtimeId: "my_agent-AbC123XyZ9",
    startTimeMs: 1_700_000_000_123,
    endTimeMs: 1_700_003_600_456,
    limit: 5,
  };

  test("aggregates traces with a stats-by-traceId query over the runtime log group", async () => {
    const { logs, queries } = insightsLogs([]);

    await clientWith(logs).listRuntimeTraces(INPUT, OPTIONS);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.logGroupNames).toEqual([
      "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
    ]);
    // Epoch ms narrows to whole seconds.
    expect(queries[0]!.startTime).toBe(1_700_000_000);
    expect(queries[0]!.endTime).toBe(1_700_003_600);
    expect(queries[0]!.queryString).toBe(
      'filter ispresent(traceId) and traceId != ""\n' +
        "| stats earliest(@timestamp) as firstSeen, latest(@timestamp) as lastSeen, " +
        "count(*) as spanCount, earliest(attributes.session.id) as sessionId by traceId\n" +
        "| sort lastSeen desc\n" +
        "| limit 5",
    );
  });

  test("parses result rows into trace summaries, skipping rows without a trace id", async () => {
    const { logs } = insightsLogs([
      [
        { field: "traceId", value: "abc123" },
        { field: "firstSeen", value: "1700000000000" },
        { field: "lastSeen", value: "1700000005000" },
        { field: "spanCount", value: "12" },
        { field: "sessionId", value: "session-1" },
      ],
      [{ field: "lastSeen", value: "1700000001000" }],
      [
        { field: "traceId", value: "def456" },
        { field: "firstSeen", value: "1700000002000" },
      ],
    ]);

    const traces = await clientWith(logs).listRuntimeTraces(INPUT, OPTIONS);

    expect(traces).toEqual([
      {
        traceId: "abc123",
        timestamp: "1700000005000",
        sessionId: "session-1",
        spanCount: "12",
      },
      // lastSeen falls back to firstSeen; sessionId/spanCount stay undefined.
      { traceId: "def456", timestamp: "1700000002000", sessionId: undefined, spanCount: undefined },
    ]);
  });

  test("translates a missing log group into invoked-yet guidance", async () => {
    const logs = fakeLogs(async () => {
      throw new ResourceNotFoundException({ message: "no such group", $metadata: {} });
    });

    await expect(clientWith(logs).listRuntimeTraces(INPUT, OPTIONS)).rejects.toThrow(
      "Has the runtime been invoked yet?",
    );
  });
});

describe("ObservabilityClient.getRuntimeTrace", () => {
  const INPUT = {
    runtimeId: "my_agent-AbC123XyZ9",
    traceId: "68b2fabc0000000000abcdef",
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_003_600_000,
  };

  test("rejects a malformed trace id before querying", async () => {
    const logs = fakeLogs(async () => {
      throw new Error("must not be called");
    });

    await expect(
      clientWith(logs).getRuntimeTrace({ ...INPUT, traceId: "not'a$trace" }, OPTIONS),
    ).rejects.toThrow("Invalid trace ID format. Expected a hex string (e.g., abc123def456).");
  });

  test("downloads the trace's records with @message parsed when it is JSON", async () => {
    const { logs, queries } = insightsLogs([
      [
        { field: "@timestamp", value: "2026-08-30 12:00:00.000" },
        { field: "@message", value: '{"traceId":"68b2fabc","body":"hello"}' },
        { field: "@ptr", value: "pointer-1" },
      ],
      [
        { field: "@timestamp", value: "2026-08-30 12:00:01.000" },
        { field: "@message", value: "not json" },
      ],
    ]);

    const records = await clientWith(logs).getRuntimeTrace(INPUT, OPTIONS);

    expect(queries[0]!.queryString).toBe(
      "fields @timestamp, @message\n" +
        "| filter traceId = '68b2fabc0000000000abcdef'\n" +
        "| sort @timestamp asc\n" +
        "| limit 10000",
    );
    expect(records).toEqual([
      {
        "@timestamp": "2026-08-30 12:00:00.000",
        "@message": { traceId: "68b2fabc", body: "hello" },
        "@ptr": "pointer-1",
      },
      { "@timestamp": "2026-08-30 12:00:01.000", "@message": "not json" },
    ]);
  });

  test("fails when the trace has no records", async () => {
    const { logs } = insightsLogs([]);

    await expect(clientWith(logs).getRuntimeTrace(INPUT, OPTIONS)).rejects.toThrow(
      "No trace data found for trace ID: 68b2fabc0000000000abcdef",
    );
  });
});
