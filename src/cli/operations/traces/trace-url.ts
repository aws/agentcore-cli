import { arnPrefix, consoleDomain } from '../../aws/partition';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';

/**
 * Builds the CloudWatch console URL for viewing agent traces.
 */
export function buildTraceConsoleUrl(params: {
  region: string;
  accountId: string;
  runtimeId: string;
  agentName: string;
}): string {
  const { region, accountId, runtimeId, agentName } = params;
  const resourceId = encodeURIComponent(
    `${arnPrefix(region)}:bedrock-agentcore:${region}:${accountId}:runtime/${runtimeId}/runtime-endpoint/${DEFAULT_ENDPOINT_NAME}:${DEFAULT_ENDPOINT_NAME}`
  );
  return `https://${region}.${consoleDomain(region)}/cloudwatch/home?region=${region}#/gen-ai-observability/agent-core/agent-alias/${runtimeId}/endpoint/${DEFAULT_ENDPOINT_NAME}/agent/${agentName}?start=-43200000&resourceId=${resourceId}&serviceName=${agentName}.${DEFAULT_ENDPOINT_NAME}&tabId=traces`;
}
