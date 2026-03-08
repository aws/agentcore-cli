import { getErrorMessage, isAccessDeniedError } from '../errors';
import { getCredentialProvider } from './account';
import { ApplicationSignalsClient, StartDiscoveryCommand } from '@aws-sdk/client-application-signals';
import {
  CloudWatchLogsClient,
  DescribeResourcePoliciesCommand,
  PutResourcePolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  GetTraceSegmentDestinationCommand,
  UpdateIndexingRuleCommand,
  UpdateTraceSegmentDestinationCommand,
  XRayClient,
} from '@aws-sdk/client-xray';

export interface TransactionSearchEnableResult {
  success: boolean;
  error?: string;
}

const RESOURCE_POLICY_NAME = 'TransactionSearchXRayAccess';

/**
 * Enable CloudWatch Transaction Search:
 * 1. Start Application Signals discovery (idempotent)
 * 2. Create CloudWatch Logs resource policy for X-Ray access (if needed)
 * 3. Set trace segment destination to CloudWatchLogs
 * 4. Set indexing to 100%
 *
 * All operations are idempotent — safe to call on every deploy.
 */
export async function enableTransactionSearch(
  region: string,
  accountId: string,
  indexPercentage = 100
): Promise<TransactionSearchEnableResult> {
  const credentials = getCredentialProvider();

  // Step 1: Enable Application Signals (creates service-linked role, idempotent)
  try {
    const appSignalsClient = new ApplicationSignalsClient({ region, credentials });
    await appSignalsClient.send(new StartDiscoveryCommand({}));
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    if (isAccessDeniedError(err)) {
      return { success: false, error: `Insufficient permissions to enable Application Signals: ${message}` };
    }
    return { success: false, error: `Failed to enable Application Signals: ${message}` };
  }

  // Step 2: Create CloudWatch Logs resource policy for X-Ray (if needed)
  try {
    const logsClient = new CloudWatchLogsClient({ region, credentials });
    const policiesResult = await logsClient.send(new DescribeResourcePoliciesCommand({}));
    const hasPolicy = policiesResult.resourcePolicies?.some(p => p.policyName === RESOURCE_POLICY_NAME);

    if (!hasPolicy) {
      const policyDocument = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: { Service: 'xray.amazonaws.com' },
            Action: 'logs:PutLogEvents',
            Resource: [
              `arn:aws:logs:${region}:${accountId}:log-group:aws/spans:*`,
              `arn:aws:logs:${region}:${accountId}:log-group:/aws/application-signals/data:*`,
            ],
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:aws:xray:${region}:${accountId}:*` },
              StringEquals: { 'aws:SourceAccount': accountId },
            },
          },
        ],
      });
      await logsClient.send(new PutResourcePolicyCommand({ policyName: RESOURCE_POLICY_NAME, policyDocument }));
    }
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    if (isAccessDeniedError(err)) {
      return { success: false, error: `Insufficient permissions to configure CloudWatch Logs policy: ${message}` };
    }
    return { success: false, error: `Failed to configure CloudWatch Logs policy: ${message}` };
  }

  const xrayClient = new XRayClient({ region, credentials });

  // Step 3: Set trace segment destination to CloudWatchLogs
  try {
    const destResult = await xrayClient.send(new GetTraceSegmentDestinationCommand({}));
    if (destResult.Destination !== 'CloudWatchLogs') {
      await xrayClient.send(new UpdateTraceSegmentDestinationCommand({ Destination: 'CloudWatchLogs' }));
    }
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    if (isAccessDeniedError(err)) {
      return { success: false, error: `Insufficient permissions to configure trace destination: ${message}` };
    }
    return { success: false, error: `Failed to configure trace destination: ${message}` };
  }

  // Step 4: Set indexing to 100% on the built-in Default rule (always exists, idempotent)
  try {
    await xrayClient.send(
      new UpdateIndexingRuleCommand({
        Name: 'Default',
        Rule: { Probabilistic: { DesiredSamplingPercentage: indexPercentage } },
      })
    );
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    if (isAccessDeniedError(err)) {
      return { success: false, error: `Insufficient permissions to configure indexing rules: ${message}` };
    }
    return { success: false, error: `Failed to configure indexing rules: ${message}` };
  }

  return { success: true };
}
