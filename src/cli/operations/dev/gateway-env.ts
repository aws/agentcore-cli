import { ConfigIO } from '../../../lib/index.js';

export async function getGatewayEnvVars(): Promise<Record<string, string>> {
  const configIO = new ConfigIO();
  const envVars: Record<string, string> = {};

  try {
    const deployedState = await configIO.readDeployedState();
    const project = await configIO.readProjectSpec();

    // Iterate all targets (not just 'default')
    for (const target of Object.values(deployedState?.targets ?? {})) {
      const gateways = target?.resources?.mcp?.gateways ?? {};

      for (const [name, gateway] of Object.entries(gateways)) {
        if (!gateway.gatewayUrl) continue;
        const sanitized = name.toUpperCase().replace(/-/g, '_');
        envVars[`AGENTCORE_GATEWAY_${sanitized}_URL`] = gateway.gatewayUrl;

        const gatewaySpec = project.agentCoreGateways?.find(g => g.name === name);
        const authType = gatewaySpec?.authorizerType ?? 'NONE';
        envVars[`AGENTCORE_GATEWAY_${sanitized}_AUTH_TYPE`] = authType;
      }
    }
  } catch {
    // No deployed state or project spec issue — skip gateway env vars
  }

  return envVars;
}
