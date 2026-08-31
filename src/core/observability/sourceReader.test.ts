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
import type { ClientConfig } from "../types";
import { CloudWatchSourceReader, type RawLogRecord } from "./sourceReader";

const SOURCE = {
  provider: "cloudwatch" as const,
  logGroupName: "/aws/bedrock-agentcore/runtimes/runtime-1-DEFAULT",
};
const OPTIONS = {
  region: "us-west-2",
  endpointUrl: "https://logs.test",
};

type Send = (command: unknown, options?: unknown) => Promise<unknown>;

function readerWith(send: Send) {
  const configs: ClientConfig[] = [];
  const logs = { send } as unknown as CloudWatchLogsClient;
  const reader = new CloudWatchSourceReader({
    logs: (config) => {
      configs.push(config);
      return logs;
    },
  });
  return { reader, configs };
}

async function collect(records: AsyncIterable<RawLogRecord>) {
  const result: RawLogRecord[] = [];
  for await (const record of records) result.push(record);
  return result;
}

describe("CloudWatchSourceReader.searchLogs", () => {
  test("paginates, preserves provider metadata, and uses the configured client", async () => {
    const inputs: unknown[] = [];
    const { reader, configs } = readerWith(async (command) => {
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
      reader.searchLogs(
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
      { timestamp: 1, message: "one" },
      { timestamp: 2, message: "two" },
      { timestamp: 3, message: "three" },
    ]);
    expect(records[2]).toMatchObject({
      ingestionTime: 4,
      logStreamName: "stream-b",
      raw: { eventId: "event-3" },
    });
  });

  test("applies a total limit across CloudWatch pages", async () => {
    const requestedLimits: (number | undefined)[] = [];
    const { reader } = readerWith(async (command) => {
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
      reader.searchLogs(SOURCE, { startTimeMs: 1, endTimeMs: 2, limit: 3 }, OPTIONS),
    );

    expect(records.map((record) => record.message)).toEqual(["one", "two", "three"]);
    expect(requestedLimits).toEqual([3, 1]);
  });

  test("translates a missing group into customer guidance", async () => {
    const { reader } = readerWith(async () => {
      throw new ResourceNotFoundException({
        message: "missing",
        $metadata: {},
      });
    });

    await expect(
      collect(reader.searchLogs(SOURCE, { startTimeMs: 1, endTimeMs: 2 }, OPTIONS)),
    ).rejects.toThrow(
      `CloudWatch log group ${SOURCE.logGroupName} does not exist. ` +
        "Has the resource been invoked or emitted logs yet?",
    );
  });
});

describe("CloudWatchSourceReader.queryLogs", () => {
  test("runs an Insights query and flattens result fields", async () => {
    const { reader } = readerWith(async (command) => {
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
      reader.queryLogs(
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
    const { reader } = readerWith(async () => {
      throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
    });

    await expect(
      reader.queryLogs(
        SOURCE,
        { queryString: "fields @message", startTimeMs: 1_000, endTimeMs: 2_000 },
        OPTIONS,
      ),
    ).rejects.toThrow("Has the resource been invoked or emitted logs yet?");
  });
});

describe("CloudWatchSourceReader.tailLogs", () => {
  const GROUP_ARN = "arn:aws:logs:us-west-2:111122223333:log-group:" + SOURCE.logGroupName;

  type LiveTailEvent = Partial<StartLiveTailResponseStream>;

  function liveTailReader(
    sessions: (LiveTailEvent[] | Error)[],
    groups: { logGroupName?: string; logGroupArn?: string; arn?: string }[] = [
      { logGroupName: SOURCE.logGroupName, logGroupArn: GROUP_ARN },
    ],
  ) {
    const starts: unknown[] = [];
    const { reader } = readerWith(async (command) => {
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
    return { reader, starts };
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
    const { reader, starts } = liveTailReader([[update("one", "two"), update("three")]]);

    const records = await collect(
      reader.tailLogs(SOURCE, { filterPattern: "ERROR" }, OPTIONS, new AbortController().signal),
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
    const { reader, starts } = liveTailReader([
      [
        update("one"),
        {
          SessionTimeoutException: { name: "SessionTimeoutException" },
        } as never,
      ],
      [update("two")],
    ]);

    const records = await collect(
      reader.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal),
    );

    expect(records.map((record) => record.message)).toEqual(["one", "two"]);
    expect(starts).toHaveLength(2);
  });

  test("stops cleanly when the caller aborts an active session", async () => {
    const controller = new AbortController();
    const { reader, starts } = liveTailReader([
      [
        update("one"),
        {
          SessionTimeoutException: { name: "SessionTimeoutException" },
        } as never,
      ],
    ]);
    const messages: string[] = [];

    for await (const record of reader.tailLogs(SOURCE, {}, OPTIONS, controller.signal)) {
      messages.push(record.message);
      controller.abort();
    }

    expect(messages).toEqual(["one"]);
    expect(starts).toHaveLength(1);
  });

  test("strips the legacy ARN suffix", async () => {
    const { reader, starts } = liveTailReader(
      [[]],
      [{ logGroupName: SOURCE.logGroupName, arn: `${GROUP_ARN}:*` }],
    );

    await collect(reader.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal));

    expect(starts).toEqual([{ logGroupIdentifiers: [GROUP_ARN] }]);
  });

  test("fails before starting a session when the group is absent", async () => {
    const { reader } = liveTailReader([[]], []);

    await expect(
      collect(reader.tailLogs(SOURCE, {}, OPTIONS, new AbortController().signal)),
    ).rejects.toThrow("Has the resource been invoked or emitted logs yet?");
  });
});
