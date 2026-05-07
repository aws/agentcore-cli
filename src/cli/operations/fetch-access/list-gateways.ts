import { ConfigIO } from '../../../lib';
import type { GatewayInfo } from './types';

export async function listGateways(
  options: { configIO?: ConfigIO; deployTarget?: string } = {}
): Promise<GatewayInfo[]> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) return [];

  const targetName = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[targetName];
  if (!target) return [];

  const deployedGateways = target.resources?.mcp?.gateways ?? {};

  const gateways: GatewayInfo[] = [];

  for (const gateway of projectSpec.agentCoreGateways) {
    const deployed = deployedGateways[gateway.name];
    if (!deployed?.gatewayUrl) continue;

    gateways.push({
      name: gateway.name,
      authType: gateway.authorizerType,
    });
  }

  // Include HTTP gateways (auto-created for A/B testing)
  const deployedHttpGateways = target.resources?.httpGateways ?? {};
  for (const httpGateway of projectSpec.httpGateways ?? []) {
    const deployed = deployedHttpGateways[httpGateway.name];
    if (!deployed?.gatewayArn) continue;

    gateways.push({
      name: httpGateway.name,
      authType: 'AWS_IAM',
    });
  }

  return gateways;
}
