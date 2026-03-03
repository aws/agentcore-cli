import { getCredentialProvider } from './account';
import { CloudWatchLogsClient, FilterLogEventsCommand, StartLiveTailCommand } from '@aws-sdk/client-cloudwatch-logs';

export interface LogEvent {
  timestamp: number;
  message: string;
}

export interface StreamLogsOptions {
  logGroupName: string;
  region: string;
  accountId: string;
  filterPattern?: string;
  abortSignal?: AbortSignal;
}

export interface SearchLogsOptions {
  logGroupName: string;
  region: string;
  startTimeMs: number;
  endTimeMs: number;
  filterPattern?: string;
  limit?: number;
}

/**
 * Stream logs in real-time using StartLiveTail.
 * Auto-reconnects on 3-hour session timeout.
 */
export async function* streamLogs(options: StreamLogsOptions): AsyncGenerator<LogEvent> {
  const { logGroupName, region, accountId, filterPattern, abortSignal } = options;

  // StartLiveTail requires ARN format for logGroupIdentifiers
  const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`;

  while (!abortSignal?.aborted) {
    const client = new CloudWatchLogsClient({
      region,
      credentials: getCredentialProvider(),
    });

    const command = new StartLiveTailCommand({
      logGroupIdentifiers: [logGroupArn],
      ...(filterPattern ? { logEventFilterPattern: filterPattern } : {}),
    });

    const response = await client.send(command, {
      abortSignal,
    });

    if (!response.responseStream) {
      return;
    }

    let sessionTimedOut = false;

    try {
      for await (const event of response.responseStream) {
        if (abortSignal?.aborted) break;

        if ('sessionUpdate' in event && event.sessionUpdate) {
          const logEvents = event.sessionUpdate.sessionResults ?? [];
          for (const logEvent of logEvents) {
            yield {
              timestamp: logEvent.timestamp ?? Date.now(),
              message: logEvent.message ?? '',
            };
          }
        }

        if ('SessionTimeoutException' in event) {
          sessionTimedOut = true;
          break;
        }
      }
    } catch (err: unknown) {
      if (abortSignal?.aborted) return;

      const errorName = (err as { name?: string })?.name;
      if (errorName === 'SessionTimeoutException') {
        sessionTimedOut = true;
      } else {
        throw err;
      }
    }

    // Auto-reconnect on session timeout
    if (!sessionTimedOut) return;
  }
}

/**
 * Search logs using FilterLogEvents with pagination.
 */
export async function* searchLogs(options: SearchLogsOptions): AsyncGenerator<LogEvent> {
  const { logGroupName, region, startTimeMs, endTimeMs, filterPattern, limit } = options;

  const client = new CloudWatchLogsClient({
    region,
    credentials: getCredentialProvider(),
  });

  let nextToken: string | undefined;
  let yielded = 0;

  do {
    const command = new FilterLogEventsCommand({
      logGroupName,
      startTime: startTimeMs,
      endTime: endTimeMs,
      ...(filterPattern ? { filterPattern } : {}),
      ...(nextToken ? { nextToken } : {}),
      ...(limit ? { limit: Math.min(limit - yielded, 10000) } : {}),
    });

    const response = await client.send(command);

    for (const event of response.events ?? []) {
      if (limit && yielded >= limit) return;

      yield {
        timestamp: event.timestamp ?? Date.now(),
        message: event.message ?? '',
      };
      yielded++;
    }

    nextToken = response.nextToken;
  } while (nextToken && (!limit || yielded < limit));
}
