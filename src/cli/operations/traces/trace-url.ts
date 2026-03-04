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

/**
 * Parses an AgentCore runtime ARN to extract region, account ID, and runtime ID.
 *
 * ARN format: arn:aws:bedrock:REGION:ACCOUNT_ID:agent-runtime/RUNTIME_ID
 * Also supports: arn:aws:bedrock-agentcore:REGION:ACCOUNT_ID:runtime/RUNTIME_ID/...
 */
export function parseRuntimeArn(arn: string): { region: string; accountId: string; runtimeId: string } | null {
  // arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-xxx
  const parts = arn.split(':');
  if (parts.length < 6) return null;

  const region = parts[3]!;
  const accountId = parts[4]!;

  // Extract runtime ID from the resource part
  const resource = parts.slice(5).join(':');
  const runtimeMatch = /(?:agent-runtime|runtime)\/([^/]+)/.exec(resource);
  if (!runtimeMatch) return null;

  return { region, accountId, runtimeId: runtimeMatch[1]! };
}
