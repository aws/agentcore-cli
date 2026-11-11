import { getCredentialProvider } from '../aws/account';
import {
  FAILURE_EVENT_TIMEOUT_MS,
  MAX_FAILURE_EVENT_PAGES,
  MAX_FAILURE_EVENT_REASONS,
  MAX_FAILURE_REASON_LENGTH,
} from './constants';
import { CloudFormationClient, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { stripVTControlCharacters } from 'node:util';

/** Best-effort diagnostics only: never replace a deployment failure with a lookup failure. */
export async function getDeploymentFailureDetails(
  stackNames: string[],
  region: string,
  startedAt: Date,
  profile?: string
): Promise<string> {
  const cfn = new CloudFormationClient({
    region,
    credentials: profile ? fromNodeProviderChain({ profile }) : getCredentialProvider(),
    maxAttempts: 1,
  });
  const reasons = new Set<string>();
  const abortSignal = AbortSignal.timeout(FAILURE_EVENT_TIMEOUT_MS);
  let pages = 0;
  try {
    for (const stackName of stackNames) {
      let nextToken: string | undefined;
      const seenTokens = new Set<string>();
      try {
        do {
          if (pages++ >= MAX_FAILURE_EVENT_PAGES || abortSignal.aborted) break;
          const page = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName, NextToken: nextToken }), {
            abortSignal,
          });
          let reachedOlderEvents = false;
          for (const event of page.StackEvents ?? []) {
            if (!event.Timestamp || event.Timestamp < startedAt) {
              if (event.Timestamp) reachedOlderEvents = true;
              continue;
            }
            if (!event.ResourceStatus?.endsWith('_FAILED') || !event.ResourceStatusReason) continue;
            // Cancellation is a consequence, not the causal failure.
            if (/resource (creation|update) cancelled/i.test(event.ResourceStatusReason)) continue;
            const reason = stripVTControlCharacters(event.ResourceStatusReason)
              .replace(/\s+/g, ' ')
              .slice(0, MAX_FAILURE_REASON_LENGTH);
            reasons.add(
              `${stackName} / ${event.LogicalResourceId ?? 'unknown resource'} (${event.ResourceStatus}): ${reason}`
            );
            if (reasons.size >= MAX_FAILURE_EVENT_REASONS) break;
          }
          if (reachedOlderEvents || reasons.size >= MAX_FAILURE_EVENT_REASONS) break;
          nextToken = page.NextToken;
          if (nextToken && seenTokens.has(nextToken)) break;
          if (nextToken) seenTokens.add(nextToken);
        } while (nextToken);
      } catch {
        // Missing permission, deleted stack, timeout, etc. must not mask the original error.
      }
      if (pages >= MAX_FAILURE_EVENT_PAGES || reasons.size >= MAX_FAILURE_EVENT_REASONS || abortSignal.aborted) break;
    }
  } finally {
    cfn.destroy();
  }
  const details = reasons.size ? `\nCloudFormation failure events:\n${[...reasons].join('\n')}` : '';
  const commands = stackNames.map(
    name =>
      `aws cloudformation describe-stack-events --stack-name ${JSON.stringify(name)} --region ${JSON.stringify(region)}` +
      (profile ? ` --profile ${JSON.stringify(profile)}` : '')
  );
  return `${details}\nInspect stack events${reasons.size ? ' for full details' : ' (automatic diagnostics unavailable or no recent failures found)'}:\n${commands.join('\n')}`;
}
