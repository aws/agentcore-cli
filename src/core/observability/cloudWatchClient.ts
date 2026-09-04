import {
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  ResourceNotFoundException,
  StartLiveTailCommand,
  type FilteredLogEvent,
  type LiveTailSessionLogEvent,
  type OutputLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { ResourceNotFoundError, ResultTruncationError } from "../../errors";
import type { AwsClients, CoreOptions } from "../types";
import { toClientConfig } from "../utils";
import { runInsightsQuery } from "./insights";
import type {
  CloudWatchLogEvent,
  InsightsQuery,
  InsightsQueryRow,
  LogSearchQuery,
  LogSource,
  LogStreamQuery,
  LogStreamSource,
  LogTailQuery,
} from "./types";

export class CloudWatchClient {
  constructor(private readonly clients: Pick<AwsClients, "logs">) {}

  async *readLogStream(
    source: LogStreamSource,
    query: LogStreamQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    if (query.maxPages !== undefined && query.maxPages <= 0) return;

    const logs = this.clients.logs(toClientConfig(options));
    let nextToken: string | undefined;
    let pages = 0;

    while (true) {
      if (query.maxPages !== undefined && pages >= query.maxPages) {
        throw new ResultTruncationError(
          `CloudWatch log stream exceeded ${query.maxPages} pages; retrieved events are incomplete`,
          {
            meta: {
              logGroupName: source.logGroupName,
              logStreamName: source.logStreamName,
              maxPages: query.maxPages,
            },
          },
        );
      }

      const requestToken = nextToken;
      let response;
      try {
        response = await logs.send(
          new GetLogEventsCommand({
            logGroupName: source.logGroupName,
            logStreamName: source.logStreamName,
            startFromHead: true,
            ...(requestToken ? { nextToken: requestToken } : {}),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          throw missingLogStreamError(source, error);
        }
        throw error;
      }
      pages++;

      for (const event of response.events ?? []) {
        yield toCloudWatchLogEvent(event, source.logStreamName);
      }

      nextToken = response.nextForwardToken;
      if (!nextToken || nextToken === requestToken) return;
    }
  }

  async *searchLogs(
    source: LogSource,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    if (query.limit !== undefined && query.limit <= 0) return;

    const logs = this.clients.logs(toClientConfig(options));
    let nextToken: string | undefined;
    let yielded = 0;

    do {
      const requestToken = nextToken;
      let response;
      try {
        response = await logs.send(
          new FilterLogEventsCommand({
            logGroupName: source.logGroupName,
            startTime: query.startTimeMs,
            endTime: query.endTimeMs,
            ...(query.filterPattern ? { filterPattern: query.filterPattern } : {}),
            ...(requestToken ? { nextToken: requestToken } : {}),
            ...(query.limit ? { limit: Math.min(query.limit - yielded, 10_000) } : {}),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          throw missingLogGroupError(source, error);
        }
        throw error;
      }

      for (const event of response.events ?? []) {
        if (query.limit !== undefined && yielded >= query.limit) return;
        yield toCloudWatchLogEvent(event);
        yielded++;
      }

      nextToken = response.nextToken;
      if (nextToken === requestToken) return;
    } while (nextToken && (query.limit === undefined || yielded < query.limit));
  }

  async *tailLogs(
    source: LogSource,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    const logs = this.clients.logs(toClientConfig(options));
    const described = await logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: source.logGroupName }),
      { abortSignal: signal },
    );
    const group = (described.logGroups ?? []).find(
      (candidate) => candidate.logGroupName === source.logGroupName,
    );
    // The legacy ARN field includes a suffix that StartLiveTail rejects.
    const logGroupArn = group?.logGroupArn ?? group?.arn?.replace(/:\*$/, "");
    if (!logGroupArn) {
      throw missingLogGroupError(source);
    }

    while (!signal.aborted) {
      let response;
      try {
        response = await logs.send(
          new StartLiveTailCommand({
            logGroupIdentifiers: [logGroupArn],
            ...(query.filterPattern ? { logEventFilterPattern: query.filterPattern } : {}),
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (!response.responseStream) return;

      let sessionTimedOut = false;
      try {
        for await (const event of response.responseStream) {
          if (signal.aborted) return;
          for (const logEvent of event.sessionUpdate?.sessionResults ?? []) {
            yield toCloudWatchLogEvent(logEvent);
          }
          if (event.SessionTimeoutException) {
            sessionTimedOut = true;
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if ((error as { name?: string }).name === "SessionTimeoutException") {
          sessionTimedOut = true;
        } else {
          throw error;
        }
      }

      if (!sessionTimedOut) return;
    }
  }

  async queryLogs(
    source: LogSource,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]> {
    const logs = this.clients.logs(toClientConfig(options));
    try {
      const rows = await runInsightsQuery(
        logs,
        [source.logGroupName],
        query.queryString,
        Math.floor(query.startTimeMs / 1000),
        Math.floor(query.endTimeMs / 1000),
        query.rowLimit,
        signal,
      );
      return rows.map((row) => {
        const result: InsightsQueryRow = {};
        for (const field of row) {
          if (field.field && field.value !== undefined) result[field.field] = field.value;
        }
        return result;
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        throw missingLogGroupError(source, error);
      }
      throw error;
    }
  }
}

function toCloudWatchLogEvent(
  event: FilteredLogEvent | LiveTailSessionLogEvent | OutputLogEvent,
  logStreamName?: string,
): CloudWatchLogEvent {
  return {
    timestamp: new Date(event.timestamp ?? Date.now()),
    message: event.message ?? "",
    ...(event.ingestionTime !== undefined ? { ingestionTime: new Date(event.ingestionTime) } : {}),
    ...("logStreamName" in event && event.logStreamName
      ? { logStreamName: event.logStreamName }
      : logStreamName
        ? { logStreamName }
        : {}),
  };
}

function missingLogGroupError(source: LogSource, cause?: unknown): ResourceNotFoundError {
  return new ResourceNotFoundError(
    `CloudWatch log group ${source.logGroupName} does not exist. ` +
      "Has the resource been invoked or emitted logs yet?",
    { cause, meta: { logGroupName: source.logGroupName } },
  );
}

function missingLogStreamError(source: LogStreamSource, cause?: unknown): ResourceNotFoundError {
  return new ResourceNotFoundError(
    `CloudWatch log stream ${source.logStreamName} does not exist in log group ` +
      `${source.logGroupName}. Has the resource emitted results yet?`,
    {
      cause,
      meta: {
        logGroupName: source.logGroupName,
        logStreamName: source.logStreamName,
      },
    },
  );
}
