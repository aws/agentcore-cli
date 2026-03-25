import { ConfigIO } from '../../../lib';
import { fetchOAuthToken } from './oauth-token';
import type { TokenFetchResult } from './types';

export async function fetchGatewayToken(
  gatewayName: string,
  options: { configIO?: ConfigIO; deployTarget?: string } = {}
): Promise<TokenFetchResult> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const targetName = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[targetName];
  if (!target) {
    throw new Error(`Deployment target '${targetName}' not found. Available targets: ${targetNames.join(', ')}`);
  }

  const gatewaySpec = projectSpec.agentCoreGateways.find(g => g.name === gatewayName);
  if (!gatewaySpec) {
    const available = projectSpec.agentCoreGateways.map(g => g.name);
    throw new Error(
      `Gateway '${gatewayName}' not found in MCP configuration. Available gateways: ${available.join(', ') || 'none'}`
    );
  }

  const deployedGateways = target.resources?.mcp?.gateways ?? {};
  const deployedGateway = deployedGateways[gatewayName];
  if (!deployedGateway?.gatewayUrl) {
    throw new Error(
      `Gateway '${gatewayName}' does not have a deployed URL. Run \`agentcore deploy\` to deploy the gateway.`
    );
  }

  const gatewayUrl = deployedGateway.gatewayUrl;
  const authType = gatewaySpec.authorizerType;

  if (authType === 'NONE') {
    return {
      url: gatewayUrl,
      authType: 'NONE',
      message: 'No authentication required. Send requests directly to the URL.',
    };
  }

  if (authType === 'AWS_IAM') {
    return {
      url: gatewayUrl,
      authType: 'AWS_IAM',
      message: 'This gateway uses AWS IAM auth. Sign requests with SigV4 using your IAM credentials.',
    };
  }

  // CUSTOM_JWT: perform OAuth client_credentials flow
  const jwtConfig = gatewaySpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(
      `Gateway '${gatewayName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`
    );
  }

  const result = await fetchOAuthToken({
    resourceName: gatewayName,
    jwtConfig,
    deployedState,
    targetName,
    credentials: projectSpec.credentials,
  });

  return {
    url: gatewayUrl,
    authType: 'CUSTOM_JWT',
    token: result.token,
    expiresIn: result.expiresIn,
  };
}
