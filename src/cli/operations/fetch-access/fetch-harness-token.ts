import { ConfigIO } from '../../../lib';
import { readEnvFile } from '../../../lib/utils/env';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';
import { fetchOAuthToken } from './oauth-token';
import type { OAuthTokenResult } from './oauth-token';

/**
 * Check whether auto-fetch is possible for a CUSTOM_JWT harness.
 * Returns true only if the managed OAuth credential exists in the project
 * spec AND the client secret is available in .env.local.
 */
export async function canFetchHarnessToken(
  harnessName: string,
  options: { configIO?: ConfigIO } = {}
): Promise<boolean> {
  try {
    const configIO = options.configIO ?? new ConfigIO();
    const harnessSpec = await configIO.readHarnessSpec(harnessName);

    if (harnessSpec.authorizerType !== 'CUSTOM_JWT') return false;
    if (!harnessSpec.authorizerConfiguration?.customJwtAuthorizer) return false;

    const projectSpec = await configIO.readProjectSpec();
    const credName = computeManagedOAuthCredentialName(harnessName);
    const hasCredential = projectSpec.credentials.some(
      c => c.authorizerType === 'OAuthCredentialProvider' && c.name === credName
    );
    if (!hasCredential) return false;

    const envVarPrefix = computeDefaultCredentialEnvVarName(credName);
    const envVars = await readEnvFile();
    return !!envVars[`${envVarPrefix}_CLIENT_SECRET`];
  } catch (err) {
    if (process.env.DEBUG) console.error('[canFetchHarnessToken]', err);
    return false;
  }
}

/**
 * Fetch an OAuth access token for a CUSTOM_JWT harness.
 *
 * Performs OIDC discovery and client_credentials token fetch using the
 * managed OAuth credential created during harness setup.
 */
export async function fetchHarnessToken(
  harnessName: string,
  options: { configIO?: ConfigIO; deployTarget?: string } = {}
): Promise<OAuthTokenResult> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();
  const harnessSpec = await configIO.readHarnessSpec(harnessName);

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const targetName = options.deployTarget ?? targetNames[0]!;

  if (harnessSpec.authorizerType !== 'CUSTOM_JWT') {
    throw new Error(`Harness '${harnessName}' uses ${harnessSpec.authorizerType ?? 'AWS_IAM'} auth, not CUSTOM_JWT.`);
  }

  const jwtConfig = harnessSpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(
      `Harness '${harnessName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`
    );
  }

  return fetchOAuthToken({
    resourceName: harnessName,
    jwtConfig,
    deployedState,
    targetName,
    credentials: projectSpec.credentials,
  });
}
