import { StartDiscoveryCommand } from "@aws-sdk/client-application-signals";
import {
  DescribeResourcePoliciesCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  GetTraceSegmentDestinationCommand,
  UpdateIndexingRuleCommand,
  UpdateTraceSegmentDestinationCommand,
} from "@aws-sdk/client-xray";
import { partition } from "@aws-sdk/util-endpoints";
import { TransactionSearchSetupError } from "../../errors";
import type { AwsClients, CoreOptions } from "../types";
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

const RESOURCE_POLICY_NAME = "TransactionSearchXRayAccess";
const DEFAULT_INDEX_PERCENTAGE = 100;

/** Shared observability API over explicit CloudWatch log-group targets. */
export class ObservabilityClient {
  private readonly cloudWatch: CloudWatchClient;

  constructor(private readonly clients: AwsClients) {
    this.cloudWatch = new CloudWatchClient(clients);
  }

  async isTransactionSearchEnabled(options: CoreOptions): Promise<boolean> {
    const xray = this.clients.xray(toClientConfig(options));
    const { Destination, Status } = await xray.send(new GetTraceSegmentDestinationCommand({}));
    return Destination === "CloudWatchLogs" && Status === "ACTIVE";
  }

  // Hard-fails (TransactionSearchSetupError) if any step is denied: the deploy
  // that calls this depends on spans being delivered. Every step is idempotent.
  async enableTransactionSearch(
    options: CoreOptions,
    accountId: string,
    indexPercentage = DEFAULT_INDEX_PERCENTAGE,
  ): Promise<void> {
    const { region } = options;
    const config = toClientConfig(options);
    const applicationSignals = this.clients.applicationSignals(config);
    const logs = this.clients.logs(config);
    const xray = this.clients.xray(config);

    const fail = (action: string, cause: unknown): never => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new TransactionSearchSetupError(
        `Could not ${action} while enabling CloudWatch Transaction Search: ${detail}`,
        { cause },
      );
    };

    try {
      await applicationSignals.send(new StartDiscoveryCommand({}));
    } catch (cause) {
      fail("enable Application Signals", cause);
    }

    try {
      const { resourcePolicies } = await logs.send(new DescribeResourcePoliciesCommand({}));
      const alreadyGranted = resourcePolicies?.some((p) => p.policyName === RESOURCE_POLICY_NAME);
      if (!alreadyGranted) {
        const part = partition(region).name;
        const policyDocument = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: RESOURCE_POLICY_NAME,
              Effect: "Allow",
              Principal: { Service: "xray.amazonaws.com" },
              Action: "logs:PutLogEvents",
              Resource: [
                `arn:${part}:logs:${region}:${accountId}:log-group:aws/spans:*`,
                `arn:${part}:logs:${region}:${accountId}:log-group:/aws/application-signals/data:*`,
              ],
              Condition: {
                ArnLike: { "aws:SourceArn": `arn:${part}:xray:${region}:${accountId}:*` },
                StringEquals: { "aws:SourceAccount": accountId },
              },
            },
          ],
        });
        await logs.send(
          new PutResourcePolicyCommand({ policyName: RESOURCE_POLICY_NAME, policyDocument }),
        );
      }
    } catch (cause) {
      fail("configure the CloudWatch Logs resource policy", cause);
    }

    try {
      const destination = await xray.send(new GetTraceSegmentDestinationCommand({}));
      if (destination.Destination !== "CloudWatchLogs") {
        await xray.send(
          new UpdateTraceSegmentDestinationCommand({ Destination: "CloudWatchLogs" }),
        );
      }
    } catch (cause) {
      fail("set the X-Ray trace segment destination", cause);
    }

    try {
      await xray.send(
        new UpdateIndexingRuleCommand({
          Name: "Default",
          Rule: { Probabilistic: { DesiredSamplingPercentage: indexPercentage } },
        }),
      );
    } catch (cause) {
      fail("set the X-Ray indexing rule", cause);
    }
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
