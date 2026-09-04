import { describe, expect, test } from "bun:test";
import {
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  GetQueryResultsCommand,
  ResourceNotFoundException,
  StartLiveTailCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type StartLiveTailResponseStream,
} from "@aws-sdk/client-cloudwatch-logs";
import { ResultTruncationError } from "../../errors";
import type { ClientConfig } from "../types";
import { CloudWatchClient } from "./cloudWatchClient";
import type { CloudWatchLogEvent } from "./types";

const SOURCE = {
  provider: "cloudwatch" as const,
  logGroupName: "/aws/bedrock-agentcore/runtimes/runtime-1-DEFAULT",
};
const STREAM_SOURCE = {
  logGroupName: SOURCE.logGroupName,
  logStreamName: "batch-evaluation/results",
};
const OPTIONS = {
  region: "us-west-2",
  endpointUrl: "https://logs.test",
};

type Send = (command: unknown, options?: unknown) => Promise<unknown>;

function clientWith(send: Send) {
  const configs: ClientConfig[] = [];
  const logs = { send } as unknown as CloudWatchLogsClient;
  const client = new CloudWatchClient({
    logs: (config) => {
      configs.push(config);
      return logs;
    },
  });
  return { client, configs };
}

async function collect(records: AsyncIterable<CloudWatchLogEvent>) {
  const result: CloudWatchLogEvent[] = [];
  for await (const record of records) result.push(record);
  return result;
}

describe("CloudWatchClient.readLogStream", () => {
  test("reads an exact stream until the forward token stops advancing", async () => {
    const inputs: unknown[] = [];
    const { client, configs } = clientWith(async (command) => {
      expect(command).toBeInstanceOf(GetLogEventsCommand);
      const input = (command as GetLogEventsCommand).input;
      inputs.push(input);
      if (input.nextToken === "page-1") {
        return {
          events: [{ timestamp: 2, ingestionTime: 3, message: "two" }],
          nextForwardToken: "page-1",
        };
      }
      return {
        events: [{ timestamp: 1, message: "one" }],
        nextForwardToken: "page-1",
      };
    });

    const records = await collect(client.readLogStream(STREAM_SOURCE, {}, OPTIONS));

    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://logs.test" }]);
    expect(inputs).toEqual([
      {
        logGroupName: STREAM_SOURCE.logGroupName,
        logStreamName: STREAM_SOURCE.logStreamName,
        startFromHead: true,
      },
      {
        logGroupName: STREAM_SOURCE.logGroupName,
        logStreamName: STREAM_SOURCE.logStreamName,
        startFromHead: true,
        nextToken: "page-1",
      },
    ]);
    expect(records).toEqual([
      {
        timestamp: new Date(1),
        message: "one",
        logStreamName: STREAM_SOURCE.logStreamName,
      },
      {
        timestamp: new Date(2),
        ingestionTime: new Date(3),
        message: "two",
        logStreamName: STREAM_SOURCE.logStreamName,
      },
    ]);
  });

  test("throws rather than returning a partial stream at the page ceiling", async () => {
    let call = 0;
    const { client } = clientWith(async () => ({
      events: [{ timestamp: call, message: `event-${call}` }],
      nextForwardToken: `page-${call++}`,
    }));

    const error = await collect(client.readLogStream(STREAM_SOURCE, { maxPages: 2 }, OPTIONS)).then(
      () => undefined,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ResultTruncationError);
    expect((error as Error).message).toContain("retrieved events are incomplete");
    expect((error as ResultTruncationError).source).toBe("internal");
  });

  test("translates a missing stream into customer guidance", async () => {
    const { client } = clientWith(async () => {
      throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
    });

    await expect(collect(client.readLogStream(STREAM_SOURCE, {}, OPTIONS))).rejects.toThrow(
      `CloudWatch log stream ${STREAM_SOURCE.logStreamName} does not exist`,
    );
  });
});

describe("CloudWatchClient.searchLogs", () => {
  test("paginates, preserves provider metadata, and uses the configured client", async () => {
    const inputs: unknown[] = [];
    const { client, configs } = clientWith(async (command) => {
      expect(command).toBeInstanceOf(FilterLogEventsCommand);
      const input = (command as FilterLogEventsCommand).input;
      inputs.push(input);
      if (input.nextToken === "page-2") {
        return {
          events: [
            {
              timestamp: 3,
              ingestionTime: 4,
              logStreamName: "stream-b",
              message: "three",
              eventId: "event-3",
            },
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

    const records = await collect(
      client.searchLogs(
        SOURCE,
        {
          startTimeMs: 1_000,
          endTimeMs: 2_000,
          filterPattern: "ERROR database",
        },
        OPTIONS,
      ),
    );

    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://logs.test" }]);
    expect(inputs).toEqual([
      {
        logGroupName: SOURCE.logGroupName,
        startTime: 1_000,
        endTime: 2_000,
        filterPattern: "ERROR database",
      },
      {
        logGroupName: SOURCE.logGroupName,
        startTime: 1_000,
        endTime: 2_000,
        filterPattern: "ERROR database",
        nextToken: "page-2",
      },
    ]);
    expect(records.map(({ timestamp, message }) => ({ timestamp, message }))).toEqual([
      { timestamp: new Date(1), message: "one" },
      { timestamp: new Date(2), message: "two" },
      { timestamp: new Date(3), message: "three" },
    ]);
    expect(records[2]).toMatchObject({
      ingestionTime: new Date(4),
      logStreamName: "stream-b",
    });
  });

  test("applies a total limit across CloudWatch pages", async () => {
    const requestedLimits: (number | undefined)[] = [];
    const { client } = clientWith(async (command) => {
      const input = (command as FilterLogEventsCommand).input;
      requestedLimits.push(input.limit);
      return input.nextToken
        ? {
            events: [
              { timestamp: 3, message: "three" },
              { timestamp: 4, message: "four" },
            ],
          }
        : {
            events: [
              { timestamp: 1, message: "one" },
              { timestamp: 2, message: "two" },
            ],
            nextToken: "page-2",
          };
    });

    const records = await collect(
      client.searchLogs(SOURCE, { startTimeMs: 1, endTimeMs: 2, limit: 3 }, OPTIONS),
    );

    expect(records.map((record) => record.message)).toEqual(["one", "two", "three"]);
    expect(requestedLimits).toEqual([3, 1]);
  });

  test("translates a missing group into customer guidance", async () => {
    const { client } = clientWith(async () => {
      throw new ResourceNotFoundException({
        message: "missing",
        $metadata: {},
      });
    });

    await expect(
      collect(client.searchLogs(SOURCE, { startTimeMs: 1, endTimeMs: 2 }, OPTIONS)),
    ).rejects.toThrow(
      `CloudWatch log group ${SOURCE.logGroupName} does not exist. ` +
        "Has the resource been invoked or emitted logs yet?",
    );
  });
});

describe("CloudWatchClient.queryLogs", () => {
  test("runs an Insights query and flattens result fields", async () => {
    const { client } = clientWith(async (command) => {
      if (command instanceof StartQueryCommand) return { queryId: "query-1" };
      expect(command).toBeInstanceOf(GetQueryResultsCommand);
      return {
        status: "Complete",
        results: [
          [
            { field: "traceId", value: "trace-1" },
            { field: "spanCount", value: "3" },
          ],
        ],
      };
    });

    await expect(
      client.queryLogs(
        SOURCE,
        {
          queryString: "fields traceId",
          startTimeMs: 1_000,
          endTimeMs: 2_999,
        },
        OPTIONS,
      ),
    ).resolves.toEqual([{ traceId: "trace-1", spanCount: "3" }]);
  });

  test("translates a missing query log group", async () => {
    const { client } = clientWith(async () => {
      throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
    });

    await expect(
      client.queryLogs(
        SOURCE,
        { queryString: "fields @message", startTimeMs: 1_000, endTimeMs: 2_000 },
        OPTIONS,
      ),
    ).rejects.toThrow("Has the resource been invoked or emitted logs yet?");
  });
});

describe("CloudWatchClient.tailLogs", () => {
  const GROUP_ARN = "arn:aws:logs:us-west-2:111122223333:log-group:" + SOURCE.logGroupName;

  type LiveTailEvent = Partial<StartLiveTailResponseStream>;

  function liveTailReader(
    sessions: (LiveTailEvent[] | Error)[],
    groups: { logGroupName?: string; logGroupArn?: string; arn?: string }[] = [
      { logGroupName: SOURCE.logGroupName, logGroupArn: GROUP_ARN },
    ],
  ) {
    const starts: unknown[] = [];
    const { client } = clientWith(async (command) => {
      if (command instanceof DescribeLogGroupsCommand) {
        expect(command.input.logGroupNamePrefix).toBe(SOURCE.logGroupName);
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
    return { client, starts };
  }

  function update(...messages: string[]): LiveTailEvent {
    return {
      sessionUpdate: {
        sessionResults: messages.map((message, index) => ({
          timestamp: 1_000 + index,
          message,
          logStreamName: "stream-a",
        })),
      },
    };
  }

  test("resolves the exact ARN and yields Live Tail updates", async () => {
    const { client, starts } = liveTailReader([[update("one", "two"), update("three")]]);

    const records = await collect(
      client.tailLogs(SOURCE, { filterPattern: "ERROR" }, OPTIONS, new AbortController().signal),
    );

    expect(records.map((record) => record.message)).toEqual(["one", "two", "three"]);
    expect(starts).toEqual([
      {
        logGroupIdentifiers: [GROUP_ARN],
        logEventFilterPattern: "ERROR",
      },
    ]);
  });

  test("reconnects after the service times out a session", async () => {
    const { client, starts } = liveTailReader([
      [
        update("one"),
        {
          SessionTimeoutException: { name: "SessionTimeoutException" },
        } as never,
      ],
      [update("two")],
    ]);

    const records = await collect(
      client.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal),
    );

    expect(records.map((record) => record.message)).toEqual(["one", "two"]);
    expect(starts).toHaveLength(2);
  });

  test("stops cleanly when the caller aborts an active session", async () => {
    const controller = new AbortController();
    const { client, starts } = liveTailReader([
      [
        update("one"),
        {
          SessionTimeoutException: { name: "SessionTimeoutException" },
        } as never,
      ],
    ]);
    const messages: string[] = [];

    for await (const record of client.tailLogs(SOURCE, {}, OPTIONS, controller.signal)) {
      messages.push(record.message);
      controller.abort();
    }

    expect(messages).toEqual(["one"]);
    expect(starts).toHaveLength(1);
  });

  test("strips the legacy ARN suffix", async () => {
    const { client, starts } = liveTailReader(
      [[]],
      [{ logGroupName: SOURCE.logGroupName, arn: `${GROUP_ARN}:*` }],
    );

    await collect(client.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal));

    expect(starts).toEqual([{ logGroupIdentifiers: [GROUP_ARN] }]);
  });

  test("fails before starting a session when the group is absent", async () => {
    const { client } = liveTailReader([[]], []);

    await expect(
      collect(client.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal)),
    ).rejects.toThrow("Has the resource been invoked or emitted logs yet?");
  });
});
