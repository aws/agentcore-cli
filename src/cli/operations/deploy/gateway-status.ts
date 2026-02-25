/**
 * Query gateway target sync statuses after deployment.
 */
import { BedrockAgentCoreControlClient, ListGatewayTargetsCommand } from '@aws-sdk/client-bedrock-agentcore-control';

export interface TargetSyncStatus {
  name: string;
  status: string;
}

const STATUS_DISPLAY: Record<string, string> = {
  READY: '✓ synced',
  SYNCHRONIZING: '⟳ syncing...',
  SYNCHRONIZE_UNSUCCESSFUL: '⚠ sync failed',
  CREATING: '⟳ creating...',
  UPDATING: '⟳ updating...',
  UPDATE_UNSUCCESSFUL: '⚠ update failed',
  FAILED: '✗ failed',
  DELETING: '⟳ deleting...',
};

export function formatTargetStatus(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

/**
 * Get sync statuses for all targets in a gateway.
 * Returns empty array on error (non-blocking).
 */
export async function getGatewayTargetStatuses(gatewayId: string, region: string): Promise<TargetSyncStatus[]> {
  try {
    const client = new BedrockAgentCoreControlClient({ region });
    const response = await client.send(
      new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId, maxResults: 100 })
    );

    return (response.items ?? []).map(target => ({
      name: target.name ?? 'unknown',
      status: target.status ?? 'UNKNOWN',
    }));
  } catch {
    return [];
  }
}
