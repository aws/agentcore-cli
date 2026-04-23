import { serviceEndpoint } from '../../aws/partition';
import { STATUS_COLORS } from '../../tui/theme';

export type ResourceDeploymentState = 'deployed' | 'local-only' | 'pending-removal';

export const DEPLOYMENT_STATE_COLORS: Record<ResourceDeploymentState, string> = {
  deployed: STATUS_COLORS.success,
  'local-only': STATUS_COLORS.warning,
  'pending-removal': STATUS_COLORS.error,
};

export const DEPLOYMENT_STATE_LABELS: Record<ResourceDeploymentState, string> = {
  deployed: 'Deployed',
  'local-only': 'Local only',
  'pending-removal': 'Removed locally',
};

export function buildRuntimeInvocationUrl(region: string, runtimeArn: string): string {
  const encodedArn = encodeURIComponent(runtimeArn);
  return `https://${serviceEndpoint('bedrock-agentcore', region)}/runtimes/${encodedArn}/invocations`;
}
