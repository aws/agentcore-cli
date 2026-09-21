// Enabling CloudWatch Transaction Search so AgentCore delivers agent OTel spans
// to the `aws/spans` log group. Evaluations (batch, A/B, insights, online) score
// sessions by reading those spans, so deploy runs this to guarantee they exist.
// The steps are idempotent — safe to run on every deploy.

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
import { TransactionSearchSetupError } from "../../errors";
import type { AwsClients, AwsCredentials } from "../types";

const RESOURCE_POLICY_NAME = "TransactionSearchXRayAccess";
const DEFAULT_INDEX_PERCENTAGE = 100;

// The three services Transaction Search touches, sourced from the shared client
// factories so the calls route through the same cached/recorded seam as the rest
// of the CLI.
type TransactionSearchClients = Pick<AwsClients, "applicationSignals" | "logs" | "xray">;

// AWS partitions differ for GovCloud and China; the resource-policy ARNs must use
// the same partition as the account being configured.
function partitionForRegion(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

// enableTransactionSearch turns on CloudWatch Transaction Search for `accountId`
// in `region`, hard-failing (TransactionSearchSetupError) if any step is denied
// or errors — the deploy that calls this depends on spans being delivered.
export async function enableTransactionSearch(
  clients: TransactionSearchClients,
  params: {
    region: string;
    accountId: string;
    credentials?: AwsCredentials;
    indexPercentage?: number;
  },
): Promise<void> {
  const { region, accountId, credentials, indexPercentage = DEFAULT_INDEX_PERCENTAGE } = params;
  const config = { region, credentials };
  const applicationSignals = clients.applicationSignals(config);
  const logs = clients.logs(config);
  const xray = clients.xray(config);

  const fail = (action: string, cause: unknown): never => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TransactionSearchSetupError(
      `Could not ${action} while enabling CloudWatch Transaction Search: ${detail}`,
      { cause },
    );
  };

  // 1. Start Application Signals discovery — creates the service-linked role the
  // trace-segment delivery relies on. Idempotent.
  try {
    await applicationSignals.send(new StartDiscoveryCommand({}));
  } catch (cause) {
    fail("enable Application Signals", cause);
  }

  // 2. Grant X-Ray permission to deliver spans to CloudWatch Logs (once).
  try {
    const { resourcePolicies } = await logs.send(new DescribeResourcePoliciesCommand({}));
    const alreadyGranted = resourcePolicies?.some((p) => p.policyName === RESOURCE_POLICY_NAME);
    if (!alreadyGranted) {
      const partition = partitionForRegion(region);
      const policyDocument = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: RESOURCE_POLICY_NAME,
            Effect: "Allow",
            Principal: { Service: "xray.amazonaws.com" },
            Action: "logs:PutLogEvents",
            Resource: [
              `arn:${partition}:logs:${region}:${accountId}:log-group:aws/spans:*`,
              `arn:${partition}:logs:${region}:${accountId}:log-group:/aws/application-signals/data:*`,
            ],
            Condition: {
              ArnLike: { "aws:SourceArn": `arn:${partition}:xray:${region}:${accountId}:*` },
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

  // 3. Route trace segments to CloudWatch Logs (this creates `aws/spans`). Skip if
  // already pointed there.
  try {
    const destination = await xray.send(new GetTraceSegmentDestinationCommand({}));
    if (destination.Destination !== "CloudWatchLogs") {
      await xray.send(new UpdateTraceSegmentDestinationCommand({ Destination: "CloudWatchLogs" }));
    }
  } catch (cause) {
    fail("set the X-Ray trace segment destination", cause);
  }

  // 4. Index the segments so they are searchable.
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
