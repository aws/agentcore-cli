export const DEFAULT_ENDPOINT_QUALIFIER = "DEFAULT";

export function runtimeLogGroup(runtimeId: string, endpoint: string): string {
  return `/aws/bedrock-agentcore/runtimes/${runtimeId}-${endpoint}`;
}
