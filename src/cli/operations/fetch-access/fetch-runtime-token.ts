import { ConfigIO } from '../../../lib';
import { fetchOAuthToken } from './oauth-token';
import type { OAuthTokenResult } from './oauth-token';

/**
 * Fetch an OAuth access token for a CUSTOM_JWT runtime agent.
 *
 * Performs OIDC discovery and client_credentials token fetch using the
 * managed OAuth credential created during agent setup.
 */
export async function fetchRuntimeToken(
  agentName: string,
  options: { configIO?: ConfigIO; deployTarget?: string } = {}
): Promise<OAuthTokenResult> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const targetName = options.deployTarget ?? targetNames[0]!;

  const agentSpec = projectSpec.agents.find(a => a.name === agentName);
  if (!agentSpec) {
    const available = projectSpec.agents.map(a => a.name);
    throw new Error(
      `Agent '${agentName}' not found in project. Available agents: ${available.join(', ') || 'none'}`
    );
  }

  if (agentSpec.authorizerType !== 'CUSTOM_JWT') {
    throw new Error(
      `Agent '${agentName}' uses ${agentSpec.authorizerType ?? 'AWS_IAM'} auth, not CUSTOM_JWT. Token fetch is only needed for CUSTOM_JWT agents.`
    );
  }

  const jwtConfig = agentSpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(
      `Agent '${agentName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`
    );
  }

  return fetchOAuthToken({
    resourceName: agentName,
    jwtConfig,
    deployedState,
    targetName,
    credentials: projectSpec.credentials,
  });
}
