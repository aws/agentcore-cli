import { readEnvFile } from '../../../lib/utils/env';
import type { DeployedState } from '../../../schema';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';

export interface OAuthTokenResult {
  token: string;
  expiresIn?: number;
}

/**
 * Perform a client_credentials OAuth token fetch for a managed OAuth credential.
 *
 * Shared by gateway and runtime token flows. Resolves the credential from the
 * project spec and .env, performs OIDC discovery, and fetches the token.
 */
export async function fetchOAuthToken(opts: {
  /** Resource name (agent or gateway) used to derive credential name */
  resourceName: string;
  /** JWT authorizer config from the resource spec */
  jwtConfig: {
    discoveryUrl: string;
    allowedClients?: string[];
    allowedScopes?: string[];
  };
  /** Deployed state for client ID resolution */
  deployedState: DeployedState;
  /** Target name within deployed state */
  targetName: string;
  /** Project credentials list */
  credentials: { authorizerType: string; name: string }[];
}): Promise<OAuthTokenResult> {
  const { resourceName, jwtConfig, deployedState, targetName, credentials } = opts;

  const credName = computeManagedOAuthCredentialName(resourceName);

  // Validate credential exists in project spec
  const credential = credentials.find(c => c.authorizerType === 'OAuthCredentialProvider' && c.name === credName);
  if (!credential) {
    throw new Error(
      `No managed OAuth credential found for '${resourceName}'. Expected credential '${credName}'. ` +
        `Re-create the resource with --client-id and --client-secret.`
    );
  }

  // Resolve client_secret from .env.local
  const envVarPrefix = computeDefaultCredentialEnvVarName(credName);
  const secretEnvVar = `${envVarPrefix}_CLIENT_SECRET`;
  const envVars = await readEnvFile();
  const clientSecret = envVars[secretEnvVar];
  if (!clientSecret) {
    throw new Error(
      `Client secret not found in environment variable ${secretEnvVar}. Ensure .env.local file contains this value.`
    );
  }

  // Resolve client_id using 3-tier fallback
  const clientId = resolveClientId(deployedState, targetName, credName, envVarPrefix, envVars, jwtConfig);
  if (!clientId) {
    throw new Error(
      `Could not determine OAuth client ID for '${resourceName}'. Ensure the resource was created with --client-id.`
    );
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
          `This resource may require an authorization code flow (3-legged OAuth) which is not yet supported.`
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
    token: tokenData.access_token,
    expiresIn: tokenData.expires_in,
  };
}

function resolveClientId(
  deployedState: DeployedState,
  targetName: string,
  credName: string,
  envVarPrefix: string,
  envVars: Record<string, string>,
  jwtConfig: { allowedClients?: string[] }
): string | undefined {
  // Tier 1: deployed-state credentials
  const deployedCred = deployedState.targets[targetName]?.resources?.credentials?.[credName];
  if (deployedCred && 'clientId' in deployedCred) {
    return (deployedCred as Record<string, string>).clientId;
  }

  // Tier 2: env var ${envVarPrefix}_CLIENT_ID
  const clientIdEnvVar = `${envVarPrefix}_CLIENT_ID`;
  const envClientId = envVars[clientIdEnvVar];
  if (envClientId) {
    return envClientId;
  }

  // Tier 3: allowedClients[0] from config (fallback)
  if (jwtConfig.allowedClients && jwtConfig.allowedClients.length > 0) {
    return jwtConfig.allowedClients[0];
  }

  return undefined;
}
