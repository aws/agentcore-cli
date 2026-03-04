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
    `arn:aws:bedrock-agentcore:${region}:${accountId}:runtime/${runtimeId}/runtime-endpoint/DEFAULT:DEFAULT`
  );
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#/gen-ai-observability/agent-core/agent-alias/${runtimeId}/endpoint/DEFAULT/agent/${agentName}?start=-43200000&resourceId=${resourceId}&serviceName=${agentName}.DEFAULT&tabId=traces`;
}
