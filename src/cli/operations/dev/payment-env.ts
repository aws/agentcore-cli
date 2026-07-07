import { ConfigIO } from '../../../lib/index.js';
import type { AgentEnvSpec } from '../../../schema';
import { isPaymentEligibleRuntime } from '../../primitives/payment-eligible.js';

/**
 * Build payment env vars for a dev runtime. Mirrors the CDK stack's deploy-time
 * injection but reads from `deployed-state.json` (so payments only "activate"
 * locally once the project has been deployed and state is populated).
 *
 * @param runtime The agent runtime spec being launched. When provided and the
 * runtime is not eligible for payments (non-Python, non-HTTP), an empty map
 * is returned — matches the CDK behaviour of skipping ineligible runtimes.
 */
export async function getPaymentEnvVars(runtime?: AgentEnvSpec): Promise<Record<string, string>> {
  if (runtime && !isPaymentEligibleRuntime(runtime)) {
    return {};
  }

  const configIO = new ConfigIO();
  const envVars: Record<string, string> = {};

  try {
    const deployedState = await configIO.readDeployedState();

    // Iterate all targets (not just 'default')
    for (const target of Object.values(deployedState?.targets ?? {})) {
      const payments = target?.resources?.payments ?? {};

      for (const [name, payment] of Object.entries(payments)) {
        if (!payment.managerArn) continue;
        const sanitized = name.toUpperCase().replace(/-/g, '_');
        envVars[`AGENTCORE_PAYMENT_${sanitized}_MANAGER_ARN`] = payment.managerArn;
        if (payment.processPaymentRoleArn) {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_PROCESS_PAYMENT_ROLE_ARN`] = payment.processPaymentRoleArn;
        }

        const connectorEntries = Object.entries(payment.connectors ?? {});

        // Expose first connector's ID at manager level (matches CDK injection)
        const firstConnector = connectorEntries[0]?.[1];
        if (firstConnector) {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_CONNECTOR_ID`] = firstConnector.connectorId;
        }

        // Payment config env vars (parity with CDK stack injection)
        if (payment.autoPayment !== undefined) {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_AUTO_PAYMENT`] = String(payment.autoPayment);
        }
        if (payment.paymentToolAllowlist && payment.paymentToolAllowlist.length > 0) {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_TOOL_ALLOWLIST`] = payment.paymentToolAllowlist.join(',');
        }
        if (payment.networkPreferences && payment.networkPreferences.length > 0) {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_NETWORK_PREFERENCES`] = payment.networkPreferences.join(',');
        }

        // Auth mode from deployed state (mirrors CDK injection)
        if (payment.authorizerType === 'CUSTOM_JWT') {
          envVars[`AGENTCORE_PAYMENT_${sanitized}_AUTH_MODE`] = 'bearer';
        }
      }
    }
  } catch {
    // No deployed state or project spec issue — skip payment env vars
  }

  return envVars;
}
