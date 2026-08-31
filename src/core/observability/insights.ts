import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchQueryError, ResultTruncationError, type AgentCoreCLIError } from "../../errors";

export const INSIGHTS_MAX_ROWS = 100_000;

export interface InsightsRowLimit {
  maxRows: number;
  buildError: (maxRows: number) => AgentCoreCLIError;
}

const DEFAULT_ROW_LIMIT: InsightsRowLimit = {
  maxRows: INSIGHTS_MAX_ROWS,
  buildError: (maxRows) =>
    new ResultTruncationError(
      `CloudWatch Logs Insights returned too many rows (>= ${maxRows}); narrow the time window`,
    ),
};

export function sanitizeQueryValue(value: string): string {
  return value.replace(/'/g, "");
}

export async function runInsightsQuery(
  logs: CloudWatchLogsClient,
  logGroupNames: string[],
  queryString: string,
  startSec: number,
  endSec: number,
  rowLimit: InsightsRowLimit = DEFAULT_ROW_LIMIT,
  signal?: AbortSignal,
): Promise<ResultField[][]> {
  const started = await logs.send(
    new StartQueryCommand({
      logGroupNames,
      queryString,
      startTime: startSec,
      endTime: endSec,
    }),
    { abortSignal: signal },
  );
  const queryId = started.queryId;

  let status = "Running";
  for (let i = 0; i < 300 && status !== "Complete"; i++) {
    const result = await logs.send(new GetQueryResultsCommand({ queryId }), {
      abortSignal: signal,
    });
    status = result.status ?? "Unknown";
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new CloudWatchQueryError(`CloudWatch Logs Insights query ${status.toLowerCase()}`, {
        meta: { queryId, status },
      });
    }
    if (status !== "Complete") await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status !== "Complete") {
    throw new CloudWatchQueryError("CloudWatch Logs Insights query did not finish in time", {
      meta: { queryId, status },
    });
  }

  const rows: ResultField[][] = [];
  let nextToken: string | undefined;
  do {
    const result = await logs.send(new GetQueryResultsCommand({ queryId, nextToken }), {
      abortSignal: signal,
    });
    rows.push(...(result.results ?? []));
    nextToken = result.nextToken;
  } while (nextToken);

  if (rows.length >= rowLimit.maxRows) {
    throw rowLimit.buildError(rowLimit.maxRows);
  }
  return rows;
}
