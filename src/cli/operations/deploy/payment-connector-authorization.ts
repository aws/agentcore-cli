import type { AgentCoreProjectSpec, PaymentDeployedState } from '../../../schema';
import { type PaymentConnectorStatus, getPaymentConnector } from '../../aws/agentcore-payments';
import { getErrorMessage } from '../../errors';

export interface QuickCreateConnectorAuthorization {
  managerName: string;
  connectorName: string;
  connectorId?: string;
  status?: PaymentConnectorStatus;
  authorizationUrl?: string;
  error?: string;
}

export async function getQuickCreateConnectorAuthorizations(options: {
  region: string;
  projectSpec: AgentCoreProjectSpec;
  payments?: Record<string, PaymentDeployedState>;
}): Promise<QuickCreateConnectorAuthorization[]> {
  const results: QuickCreateConnectorAuthorization[] = [];

  for (const manager of options.projectSpec.payments ?? []) {
    const managerState = options.payments?.[manager.name];
    for (const connector of manager.connectors) {
      if (connector.provisionMode !== 'QUICK_CREATE') continue;

      const connectorState = managerState?.connectors[connector.name];
      if (!managerState || !connectorState) {
        results.push({
          managerName: manager.name,
          connectorName: connector.name,
          error: 'deployed connector identifiers were not found',
        });
        continue;
      }

      try {
        const detail = await getPaymentConnector({
          region: options.region,
          paymentManagerId: managerState.managerId,
          paymentConnectorId: connectorState.connectorId,
        });
        if (!detail) {
          results.push({
            managerName: manager.name,
            connectorName: connector.name,
            connectorId: connectorState.connectorId,
            error: 'connector was not found by the Payments service',
          });
          continue;
        }

        results.push({
          managerName: manager.name,
          connectorName: connector.name,
          connectorId: connectorState.connectorId,
          status: detail.status,
          authorizationUrl: detail.authorizationUrl,
        });
      } catch (error) {
        results.push({
          managerName: manager.name,
          connectorName: connector.name,
          connectorId: connectorState.connectorId,
          error: getErrorMessage(error),
        });
      }
    }
  }

  return results;
}

export function formatQuickCreateConnectorAuthorization(result: QuickCreateConnectorAuthorization): string {
  const name = `${result.managerName}/${result.connectorName}`;

  if (result.error) {
    return `Payment connector "${name}" deployed, but its live status could not be retrieved: ${result.error}. Run \`agentcore status\` to retry.`;
  }
  if (result.status === 'PENDING_AUTHENTICATION' && result.authorizationUrl) {
    return `Authorize payment connector "${name}": ${result.authorizationUrl}`;
  }
  if (result.status === 'PENDING_AUTHENTICATION') {
    return `Payment connector "${name}" is pending authorization, but no authorization URL was returned. Run \`agentcore status\` to retry.`;
  }
  if (result.status === 'READY') {
    return `Payment connector "${name}" is ready.`;
  }
  if (result.status === 'AUTHENTICATION_EXPIRED' || result.status === 'AUTHENTICATION_FAILED') {
    return `Payment connector "${name}" is ${result.status}. Remove and deploy it, then add and deploy it again to generate a new authorization URL.`;
  }
  return `Payment connector "${name}" status: ${result.status ?? 'unknown'}. Run \`agentcore status\` for the latest state.`;
}
