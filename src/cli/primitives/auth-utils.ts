import { setEnvVar } from '../../lib';
import type { AgentCoreProjectSpec, CustomClaimValidation } from '../../schema';
import { computeDefaultCredentialEnvVarName, computeManagedOAuthCredentialName } from './credential-utils';

/** Flat JWT config from TUI/CLI (pre-schema-transformation). */
export interface JwtConfigOptions {
  discoveryUrl: string;
  allowedAudience?: string[];
  allowedClients?: string[];
  allowedScopes?: string[];
  customClaims?: CustomClaimValidation[];
  clientId?: string;
  clientSecret?: string;
}

/**
 * Build the nested authorizerConfiguration schema shape from flat JWT config.
 */
export function buildAuthorizerConfigFromJwtConfig(jwtConfig: JwtConfigOptions) {
  return {
    customJwtAuthorizer: {
      discoveryUrl: jwtConfig.discoveryUrl,
      ...(jwtConfig.allowedAudience?.length ? { allowedAudience: jwtConfig.allowedAudience } : {}),
      ...(jwtConfig.allowedClients?.length ? { allowedClients: jwtConfig.allowedClients } : {}),
      ...(jwtConfig.allowedScopes?.length ? { allowedScopes: jwtConfig.allowedScopes } : {}),
      ...(jwtConfig.customClaims?.length ? { customClaims: jwtConfig.customClaims } : {}),
    },
  };
}

/**
 * Create a managed OAuth credential for inbound auth.
 * Adds the credential to the project spec and writes client secrets to .env.
 */
export async function createManagedOAuthCredential(
  resourceName: string,
  jwtConfig: JwtConfigOptions,
  writeProjectSpec: (spec: AgentCoreProjectSpec) => Promise<void>,
  readProjectSpec: () => Promise<AgentCoreProjectSpec>
): Promise<void> {
  const credentialName = computeManagedOAuthCredentialName(resourceName);
  const project = await readProjectSpec();
  if (project.credentials.some(c => c.name === credentialName)) return;

  project.credentials.push({
    authorizerType: 'OAuthCredentialProvider',
    name: credentialName,
    discoveryUrl: jwtConfig.discoveryUrl,
    vendor: 'CustomOauth2',
    managed: true,
    usage: 'inbound',
  });
  await writeProjectSpec(project);

  const envVarPrefix = computeDefaultCredentialEnvVarName(credentialName);
  await setEnvVar(`${envVarPrefix}_CLIENT_ID`, jwtConfig.clientId!);
  await setEnvVar(`${envVarPrefix}_CLIENT_SECRET`, jwtConfig.clientSecret!);
}
