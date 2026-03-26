import { ConfigIO } from '../../../lib';
import { readEnvFile } from '../../../lib/utils/env';
import type { AgentCoreProjectSpec, DeployedState } from '../../../schema';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';
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
  return fetchCustomJwtToken(gatewayName, gatewayUrl, gatewaySpec, deployedState, targetName, projectSpec);
}

async function fetchCustomJwtToken(
  gatewayName: string,
  gatewayUrl: string,
  gatewaySpec: AgentCoreProjectSpec['agentCoreGateways'][number],
  deployedState: DeployedState,
  targetName: string,
  projectSpec: { credentials: { type: string; name: string }[] }
): Promise<TokenFetchResult> {
  const jwtConfig = gatewaySpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(
      `Gateway '${gatewayName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`
    );
  }

  // Resolve credential name using the GatewayPrimitive naming convention
  const credName = computeManagedOAuthCredentialName(gatewayName);

  // Validate credential exists in project spec
  const credential = projectSpec.credentials.find(c => c.type === 'OAuthCredentialProvider' && c.name === credName);
  if (!credential) {
    throw new Error(
      `No managed OAuth credential found for gateway. Expected credential '${credName}'. ` +
        `Re-create the gateway with --client-id and --client-secret.`
    );
  }

  // Resolve client_secret from .env.local (GatewayPrimitive pattern: bare env var name)
  const secretEnvVar = computeDefaultCredentialEnvVarName(credName);
  const envVars = await readEnvFile();
  const clientSecret = envVars[secretEnvVar];
  if (!clientSecret) {
    throw new Error(
      `Client secret not found in environment variable ${secretEnvVar}. Ensure .env.local file contains this value.`
    );
  }

  // Resolve client_id using 3-tier fallback
  const clientId = resolveClientId(deployedState, targetName, credName, secretEnvVar, envVars, jwtConfig);
  if (!clientId) {
    throw new Error('Could not determine OAuth client ID. Ensure the gateway was created with --client-id.');
  }

  // Perform OIDC discovery
  const discoveryUrl = jwtConfig.discoveryUrl;
  const discoveryResponse = await fetch(discoveryUrl);
  if (!discoveryResponse.ok) {
    throw new Error(
      `OIDC discovery failed: ${discoveryResponse.status} ${discoveryResponse.statusText} (${discoveryUrl})`
    );
  }
  const discoveryDoc = (await discoveryResponse.json()) as {
    token_endpoint?: string;
    grant_types_supported?: string[];
  };
  const tokenEndpoint = discoveryDoc.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error(`OIDC discovery response missing 'token_endpoint' field (${discoveryUrl})`);
  }

  // Detect 3-legged OAuth (authorization code flow) — not supported
  const supportedGrants = discoveryDoc.grant_types_supported;
  if (supportedGrants && !supportedGrants.includes('client_credentials')) {
    throw new Error(
      `This OAuth provider does not support the client_credentials grant type. ` +
        `Supported grants: ${supportedGrants.join(', ')}. ` +
        `Authorization code flows (3-legged OAuth) requiring browser login are not yet supported.`
    );
  }

  // Build token request body
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const scopes = jwtConfig.allowedScopes;
  if (scopes && scopes.length > 0) {
    params.set('scope', scopes.join(' '));
  }

  // Request token
  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    if (errorBody.includes('unsupported_grant_type')) {
      throw new Error(
        `Token request failed: the OAuth provider rejected the client_credentials grant type. ` +
          `This gateway may require an authorization code flow (3-legged OAuth) which is not yet supported.`
      );
    }
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenResponse.statusText}. ${errorBody}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!tokenData.access_token) {
    throw new Error('Token response missing access_token field.');
  }

  return {
    url: gatewayUrl,
    authType: 'CUSTOM_JWT',
    token: tokenData.access_token,
    expiresIn: tokenData.expires_in,
  };
}

function resolveClientId(
  deployedState: DeployedState,
  targetName: string,
  credName: string,
  secretEnvVar: string,
  envVars: Record<string, string>,
  jwtConfig: { allowedClients?: string[] }
): string | undefined {
  // Tier 1: deployed-state credentials (currently dead code — CredentialDeployedStateSchema
  // has no clientId field, but preserved for forward-compatibility if schema is extended)
  const deployedCred = deployedState.targets[targetName]?.resources?.credentials?.[credName];
  if (deployedCred && 'clientId' in deployedCred) {
    return (deployedCred as Record<string, string>).clientId;
  }

  // Tier 2: env var ${secretEnvVar}_CLIENT_ID (primary real path today)
  const clientIdEnvVar = `${secretEnvVar}_CLIENT_ID`;
  const envClientId = envVars[clientIdEnvVar];
  if (envClientId) {
    return envClientId;
  }

  // Tier 3: allowedClients[0] from agentcore.json (fallback)
  if (jwtConfig.allowedClients && jwtConfig.allowedClients.length > 0) {
    return jwtConfig.allowedClients[0];
  }

  return undefined;
}
