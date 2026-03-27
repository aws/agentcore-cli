import { ConfigIO } from '../../../lib';
import { readEnvFile } from '../../../lib/utils/env';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';
import { fetchOAuthToken } from './oauth-token';
import type { OAuthTokenResult } from './oauth-token';

/**
 * Check whether auto-fetch is possible for a CUSTOM_JWT agent.
 * Returns true only if the managed OAuth credential exists in the project
 * spec AND the client secret is available in .env.local.
 */
export async function canFetchRuntimeToken(agentName: string, options: { configIO?: ConfigIO } = {}): Promise<boolean> {
  try {
    const configIO = options.configIO ?? new ConfigIO();
    const projectSpec = await configIO.readProjectSpec();

    const agentSpec = projectSpec.agents.find(a => a.name === agentName);
    if (!agentSpec?.authorizerType || agentSpec.authorizerType !== 'CUSTOM_JWT') return false;
    if (!agentSpec.authorizerConfiguration?.customJwtAuthorizer) return false;

    const credName = computeManagedOAuthCredentialName(agentName);
    const hasCredential = projectSpec.credentials.some(
      c => c.authorizerType === 'OAuthCredentialProvider' && c.name === credName
    );
    if (!hasCredential) return false;

    const envVarPrefix = computeDefaultCredentialEnvVarName(credName);
    const envVars = await readEnvFile();
    return !!envVars[`${envVarPrefix}_CLIENT_SECRET`];
  } catch {
    return false;
  }
}

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
    throw new Error(`Agent '${agentName}' not found in project. Available agents: ${available.join(', ') || 'none'}`);
  }

  if (agentSpec.authorizerType !== 'CUSTOM_JWT') {
    throw new Error(
      `Agent '${agentName}' uses ${agentSpec.authorizerType ?? 'AWS_IAM'} auth, not CUSTOM_JWT. Token fetch is only needed for CUSTOM_JWT agents.`
    );
  }

  const jwtConfig = agentSpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(`Agent '${agentName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`);
  }

  return fetchOAuthToken({
    resourceName: agentName,
    jwtConfig,
    deployedState,
    targetName,
    credentials: projectSpec.credentials,
  });
}
