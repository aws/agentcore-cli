import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { AwsClients, AwsCredentials, CoreOptions } from "../types";
import { toClientConfig } from "../utils";
import { CloudWatchClient } from "./cloudWatchClient";
import type {
  CloudWatchLogEvent,
  GetTraceQuery,
  InsightsQuery,
  InsightsQueryRow,
  ListTracesQuery,
  LogSearchQuery,
  LogSource,
  LogTailQuery,
  TraceRecord,
  TraceSummary,
} from "./types";
import {
  getTraceInsightsQuery,
  listTracesInsightsQuery,
  normalizeTraceRecords,
  normalizeTraceSummaries,
} from "./traces";
import { enableTransactionSearch } from "./transactionSearch";

// The log group AgentCore delivers agent spans to once Transaction Search is on.
const SPANS_LOG_GROUP = "aws/spans";

/** Shared observability API over explicit CloudWatch log-group targets. */
export class ObservabilityClient {
  private readonly cloudWatch: CloudWatchClient;

  constructor(private readonly clients: AwsClients) {
    this.cloudWatch = new CloudWatchClient(clients);
  }

  /**
   * True when CloudWatch Transaction Search is delivering agent traces to the
   * `aws/spans` log group in this account and region. Evaluations score sessions
   * by reading their spans from that group, so its absence means a run has
   * nothing to read. Probing the log group's existence is cheap and the same
   * signal the service keys on.
   */
  async isTransactionSearchEnabled(options: CoreOptions): Promise<boolean> {
    const logs = this.clients.logs(toClientConfig(options));
    const { logGroups } = await logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: SPANS_LOG_GROUP, limit: 1 }),
    );
    return (logGroups ?? []).some((group) => group.logGroupName === SPANS_LOG_GROUP);
  }

  // enableTransactionSearch turns Transaction Search on for a deploy target,
  // hard-failing if any step is denied. Run on every deploy; the steps are
  // idempotent.
  enableTransactionSearch(params: {
    region: string;
    accountId: string;
    credentials?: AwsCredentials;
    indexPercentage?: number;
  }): Promise<void> {
    return enableTransactionSearch(this.clients, params);
  }

  async *searchLogs(
    source: LogSource,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    yield* this.cloudWatch.searchLogs(source, query, options, signal);
  }

  async *tailLogs(
    source: LogSource,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    yield* this.cloudWatch.tailLogs(source, query, options, signal);
  }

  queryLogs(
    source: LogSource,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]> {
    return this.cloudWatch.queryLogs(source, query, options, signal);
  }

  async listTraces(
    source: LogSource,
    query: ListTracesQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceSummary[]> {
    const rows = await this.queryLogs(source, listTracesInsightsQuery(query), options, signal);
    return normalizeTraceSummaries(rows);
  }

  async getTrace(
    source: LogSource,
    query: GetTraceQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceRecord[]> {
    const rows = await this.queryLogs(source, getTraceInsightsQuery(query), options, signal);
    return normalizeTraceRecords(rows, query.traceId);
  }
}
