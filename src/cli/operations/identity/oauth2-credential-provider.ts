/**
 * Imperative AWS SDK operations for OAuth2 credential providers.
 *
 * This file exists because AgentCore Identity resources are not yet modeled
 * as CDK constructs. These operations run as a pre-deploy step outside the
 * main CDK synthesis/deploy path.
 */
import { type Result, ServiceError, toError } from '@/lib';
import { err, ok } from '@/lib/result';
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  type CredentialProviderVendorType,
  GetOauth2CredentialProviderCommand,
  ResourceNotFoundException,
  UpdateOauth2CredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export type OAuth2ProviderResult = Result<{
  credentialProviderArn: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}>;

export interface OAuth2ProviderParams {
  name: string;
  vendor: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Extract result fields from an OAuth2 API response.
 * All Create/Get/Update responses share the same shape.
 */
function extractResult(response: {
  credentialProviderArn?: string;
  clientSecretArn?: { secretArn?: string };
  callbackUrl?: string;
}): OAuth2ProviderResult {
  if (!response.credentialProviderArn) return err(new ServiceError('missing credentialProviderArn in response'));
  return ok({
    credentialProviderArn: response.credentialProviderArn,
    clientSecretArn: response.clientSecretArn?.secretArn,
    callbackUrl: response.callbackUrl,
  });
}

/**
 * Check if an OAuth2 credential provider exists.
 */
export async function oAuth2ProviderExists(
  client: BedrockAgentCoreControlClient,
  providerName: string
): Promise<boolean> {
  try {
    await client.send(new GetOauth2CredentialProviderCommand({ name: providerName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return false;
    }
    throw error;
  }
}

/**
 * Build the OAuth2 provider config for Create/Update commands.
 * Always uses customOauth2ProviderConfig — the vendor field controls server-side
 * behavior (token endpoints, scopes), but the config shape is the same for all
 * vendors in the current API. Vendor-specific config paths (e.g. googleOauth2ProviderConfig)
 * would be needed if we add vendor selection in a future phase.
 */
function buildOAuth2Config(params: OAuth2ProviderParams) {
  return {
    name: params.name,
    credentialProviderVendor: params.vendor as CredentialProviderVendorType,
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        oauthDiscovery: {
          discoveryUrl: params.discoveryUrl,
        },
      },
    },
  };
}

/**
 * Create an OAuth2 credential provider.
 * On conflict (already exists), falls back to GET to retrieve the ARN.
 */
export async function createOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  params: OAuth2ProviderParams
): Promise<OAuth2ProviderResult> {
  try {
    const response = await client.send(new CreateOauth2CredentialProviderCommand(buildOAuth2Config(params)));
    let result = extractResult(response);
    if (!result.success) {
      // Create response may not include credentialProviderArn — fetch it
      const getResult = await getOAuth2Provider(client, params.name);
      result = getResult;
    }
    return result;
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ConflictException' || errorName === 'ResourceAlreadyExistsException') {
      // Race condition: another process created the provider between our exists-check and
      // create call. Fall back to update so the user's credentials are always applied.
      return updateOAuth2Provider(client, params);
    }
    return err(toError(error));
  }
}

/**
 * Get an existing OAuth2 credential provider.
 */
export async function getOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  name: string
): Promise<OAuth2ProviderResult> {
  try {
    const response = await client.send(new GetOauth2CredentialProviderCommand({ name }));
    return extractResult(response);
  } catch (error) {
    return err(toError(error));
  }
}

/**
 * Update an existing OAuth2 credential provider.
 */
export async function updateOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  params: OAuth2ProviderParams
): Promise<OAuth2ProviderResult> {
  try {
    const response = await client.send(new UpdateOauth2CredentialProviderCommand(buildOAuth2Config(params)));
    let result = extractResult(response);
    if (!result.success) {
      const getResult = await getOAuth2Provider(client, params.name);
      result = getResult;
    }
    return result;
  } catch (error) {
    return err(toError(error));
  }
}
