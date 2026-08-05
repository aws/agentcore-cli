import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";

export function isConnectorTarget(configuration: TargetConfiguration | undefined): boolean {
  return (
    configuration?.mcp?.connector !== undefined || configuration?.inference?.connector !== undefined
  );
}
