import { SecureCredentials, readEnvFile } from '../../../lib';
import type { AgentCoreProjectSpec, Credential } from '../../../schema';
import { getCredentialProvider } from '../../aws';
import {
  createPaymentCredentialProvider,
  deletePaymentCredentialProvider,
  getPaymentCredentialProvider,
  updatePaymentCredentialProvider,
} from '../../aws/agentcore-payments';
import { isNoCredentialsError, isQuotaExceededError } from '../../errors';
import { getAwsLoginGuidance } from '../../external-requirements/checks';
import {
  computeDefaultCredentialEnvVarName,
  computePaymentCredentialEnvVarNames,
  computeStripePrivyCredentialEnvVarNames,
} from '../../primitives/credential-utils';
import {
  apiKeyProviderExists,
  createApiKeyProvider,
  createOAuth2Provider,
  oAuth2ProviderExists,
  setTokenVaultKmsKey,
  updateApiKeyProvider,
  updateOAuth2Provider,
} from '../identity';
import { BedrockAgentCoreControlClient, GetTokenVaultCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { existsSync } from 'fs';
import { join } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeyProviderSetupResult {
  providerName: string;
  status: 'created' | 'updated' | 'exists' | 'skipped' | 'error';
  credentialProviderArn?: string;
  error?: string;
}

export interface PreDeployIdentityResult {
  results: ApiKeyProviderSetupResult[];
  hasErrors: boolean;
  kmsKeyArn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupApiKeyProvidersOptions {
  projectSpec: AgentCoreProjectSpec;
  configBaseDir: string;
  region: string;
  /** Runtime credentials that override .env.local values (not persisted to disk) */
  runtimeCredentials?: SecureCredentials;
  /** Enable KMS encryption for the token vault (creates key if needed) */
  enableKmsEncryption?: boolean;
}

/**
 * Set up API key credential providers for all credentials in the project.
 * Reads API keys from agentcore/.env.local and creates providers in AgentCore Identity.
 * Runtime credentials (if provided) take precedence over .env.local values.
 */
export async function setupApiKeyProviders(options: SetupApiKeyProvidersOptions): Promise<PreDeployIdentityResult> {
  const { projectSpec, configBaseDir, region, runtimeCredentials, enableKmsEncryption } = options;
  const results: ApiKeyProviderSetupResult[] = [];
  const credentials = getCredentialProvider();

  const envVars = await readEnvFile(configBaseDir);
  // Wrap env vars in SecureCredentials and merge with runtime credentials
  const envCredentials = SecureCredentials.fromEnvVars(envVars);
  const allCredentials = runtimeCredentials ? envCredentials.merge(runtimeCredentials) : envCredentials;

  const client = new BedrockAgentCoreControlClient({ region, credentials });

  // Configure KMS encryption for token vault if enabled
  let kmsKeyArn: string | undefined;
  if (enableKmsEncryption) {
    const kmsResult = await setupTokenVaultKms(region, credentials, projectSpec);
    if (!kmsResult.success) {
      return {
        results: [
          {
            providerName: 'TokenVault',
            status: 'error',
            error: `Failed to configure KMS: ${kmsResult.error}`,
          },
        ],
        hasErrors: true,
      };
    }
    kmsKeyArn = kmsResult.keyArn;
  }

  // Set up each credential in the project
  for (const credential of projectSpec.credentials) {
    // Skip payment credentials — handled by setupPaymentCredentialProviders below
    if (credential.authorizerType === 'PaymentCredentialProvider') continue;

    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      const result = await setupApiKeyCredentialProvider(client, credential, allCredentials);
      results.push(result);
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
    kmsKeyArn,
  };
}

async function setupTokenVaultKms(
  region: string,
  credentials: ReturnType<typeof getCredentialProvider>,
  projectSpec: AgentCoreProjectSpec
): Promise<{ success: boolean; keyArn?: string; error?: string }> {
  try {
    const controlClient = new BedrockAgentCoreControlClient({ region, credentials });

    // Check if the token vault already has a customer-managed key
    try {
      const vaultResponse = await controlClient.send(new GetTokenVaultCommand({}));
      if (
        vaultResponse.kmsConfiguration?.keyType === 'CustomerManagedKey' &&
        vaultResponse.kmsConfiguration.kmsKeyArn
      ) {
        return { success: true, keyArn: vaultResponse.kmsConfiguration.kmsKeyArn };
      }
    } catch {
      // Vault may not exist yet or access denied — fall through to create key
    }

    // No CMK configured — create a new KMS key and set it on the vault
    const kmsClient = new KMSClient({ region, credentials });
    const response = await kmsClient.send(
      new CreateKeyCommand({
        Description: `AgentCore Identity encryption key for ${projectSpec.name}`,
        Tags: [{ TagKey: 'agentcore:project', TagValue: projectSpec.name }],
      })
    );
    const keyArn = response.KeyMetadata?.Arn;
    if (!keyArn) {
      return { success: false, error: 'Failed to create KMS key' };
    }

    const result = await setTokenVaultKmsKey(controlClient, keyArn);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true, keyArn };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function setupApiKeyCredentialProvider(
  client: BedrockAgentCoreControlClient,
  credential: Credential,
  credentials: SecureCredentials
): Promise<ApiKeyProviderSetupResult> {
  const envVarName = computeDefaultCredentialEnvVarName(credential.name);
  const apiKey = credentials.get(envVarName);

  if (!apiKey) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `No ${envVarName} found in agentcore/.env.local`,
    };
  }

  try {
    const exists = await apiKeyProviderExists(client, credential.name);
    if (exists) {
      // Always update to ensure provider has current credentials
      const updateResult = await updateApiKeyProvider(client, credential.name, apiKey);
      return {
        providerName: credential.name,
        status: updateResult.success ? 'updated' : 'error',
        credentialProviderArn: updateResult.credentialProviderArn,
        error: updateResult.error,
      };
    }

    const createResult = await createApiKeyProvider(client, credential.name, apiKey);
    return {
      providerName: credential.name,
      status: createResult.success ? 'created' : 'error',
      credentialProviderArn: createResult.credentialProviderArn,
      error: createResult.error,
    };
  } catch (error) {
    // Provide clearer error message for AWS credentials issues
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = `AWS credentials not found. ${await getAwsLoginGuidance()}`;
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    return {
      providerName: credential.name,
      status: 'error',
      error: errorMessage,
    };
  }
}

/**
 * Check if the project has any API key credentials that need setup.
 */
export function hasIdentityApiProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.credentials.some(c => c.authorizerType === 'ApiKeyCredentialProvider');
}

export interface MissingCredential {
  providerName: string;
  envVarName: string;
}

/**
 * Get list of credentials that are missing API keys in .env.local.
 */
export async function getMissingCredentials(
  projectSpec: AgentCoreProjectSpec,
  configBaseDir: string
): Promise<MissingCredential[]> {
  const envVars = await readEnvFile(configBaseDir);
  const missing: MissingCredential[] = [];

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      const envVarName = computeDefaultCredentialEnvVarName(credential.name);
      if (!envVars[envVarName]) {
        missing.push({
          providerName: credential.name,
          envVarName,
        });
      }
    }
  }

  return missing;
}

/**
 * Get list of all credentials in the project that need env vars (for manual entry prompt and runtime credential reading).
 * Covers ApiKey, OAuth2, and Payment connectors.
 */
export function getAllCredentials(projectSpec: AgentCoreProjectSpec): MissingCredential[] {
  const credentials: MissingCredential[] = [];

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      credentials.push({
        providerName: credential.name,
        envVarName: computeDefaultCredentialEnvVarName(credential.name),
      });
    } else if (credential.authorizerType === 'OAuthCredentialProvider') {
      const nameKey = credential.name.toUpperCase().replace(/-/g, '_');
      credentials.push(
        { providerName: credential.name, envVarName: `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_ID` },
        { providerName: credential.name, envVarName: `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_SECRET` }
      );
    }
  }

  for (const payment of projectSpec.payments ?? []) {
    for (const connector of payment.connectors) {
      if (connector.provider === 'StripePrivy') {
        const vars = computeStripePrivyCredentialEnvVarNames(connector.credentialName);
        credentials.push(
          { providerName: connector.credentialName, envVarName: vars.appId },
          { providerName: connector.credentialName, envVarName: vars.appSecret },
          { providerName: connector.credentialName, envVarName: vars.authorizationPrivateKey },
          { providerName: connector.credentialName, envVarName: vars.authorizationId }
        );
      } else {
        const vars = computePaymentCredentialEnvVarNames(connector.credentialName);
        credentials.push(
          { providerName: connector.credentialName, envVarName: vars.apiKeyId },
          { providerName: connector.credentialName, envVarName: vars.apiKeySecret },
          { providerName: connector.credentialName, envVarName: vars.walletSecret }
        );
      }
    }
  }

  return credentials;
}

/**
 * Assert that .env.local exists if any credentials require it.
 * Returns null if file exists or no credentials need it; an error message otherwise.
 *
 * The error lists every required env var across ApiKey, OAuth2, and Payment connectors
 * so the user can populate the file in one shot rather than discovering missing vars
 * one at a time across separate setup steps.
 */
export function assertEnvFileExists(projectSpec: AgentCoreProjectSpec, configBaseDir: string): string | null {
  const allCredentials = getAllCredentials(projectSpec);
  if (allCredentials.length === 0) return null;

  const envFilePath = join(configBaseDir, '.env.local');
  if (existsSync(envFilePath)) return null;

  const varList = allCredentials.map(c => `  ${c.envVarName}`).join('\n');
  return `agentcore/.env.local not found. Credentials require environment variables.\n\nRequired variables:\n${varList}\n\nTo fix: create agentcore/.env.local with the variables above, or re-run the relevant 'agentcore add' command to enter credentials interactively.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Credential Provider Setup
// ─────────────────────────────────────────────────────────────────────────────

export interface OAuth2ProviderSetupResult {
  providerName: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  error?: string;
  credentialProviderArn?: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}

export interface SetupOAuth2ProvidersOptions {
  projectSpec: AgentCoreProjectSpec;
  configBaseDir: string;
  region: string;
  runtimeCredentials?: SecureCredentials;
}

export interface PreDeployOAuth2Result {
  results: OAuth2ProviderSetupResult[];
  hasErrors: boolean;
}

/**
 * Set up OAuth2 credential providers for all OAuth credentials in the project.
 * Reads client credentials from agentcore/.env.local and creates providers in AgentCore Identity.
 */
export async function setupOAuth2Providers(options: SetupOAuth2ProvidersOptions): Promise<PreDeployOAuth2Result> {
  const { projectSpec, configBaseDir, region, runtimeCredentials } = options;
  const results: OAuth2ProviderSetupResult[] = [];
  const credentials = getCredentialProvider();

  const envVars = await readEnvFile(configBaseDir);
  const envCredentials = SecureCredentials.fromEnvVars(envVars);
  const allCredentials = runtimeCredentials ? envCredentials.merge(runtimeCredentials) : envCredentials;

  const client = new BedrockAgentCoreControlClient({ region, credentials });

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'OAuthCredentialProvider') {
      const result = await setupSingleOAuth2Provider(client, credential, allCredentials);
      results.push(result);
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

/**
 * Check if the project has any OAuth credentials that need setup.
 */
export function hasIdentityOAuthProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.credentials.some(c => c.authorizerType === 'OAuthCredentialProvider');
}

async function setupSingleOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  credential: Credential,
  credentials: SecureCredentials
): Promise<OAuth2ProviderSetupResult> {
  if (credential.authorizerType !== 'OAuthCredentialProvider') {
    return { providerName: credential.name, status: 'error', error: 'Invalid credential type' };
  }

  const nameKey = credential.name.toUpperCase().replace(/-/g, '_');
  const clientIdEnvVar = `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_ID`;
  const clientSecretEnvVar = `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_SECRET`;

  const clientId = credentials.get(clientIdEnvVar);
  const clientSecret = credentials.get(clientSecretEnvVar);

  if (!clientId || !clientSecret) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `Missing ${clientIdEnvVar} or ${clientSecretEnvVar} in agentcore/.env.local`,
    };
  }

  // Imported OAuth providers may not have a discoveryUrl (provider already exists in Identity service).
  // Skip create/update since we can't build a valid config without it.
  if (!credential.discoveryUrl) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `No discoveryUrl configured for "${credential.name}". Provider already exists in Identity service — credentials in .env.local will be ignored.`,
    };
  }

  const params = {
    name: credential.name,
    vendor: credential.vendor,
    discoveryUrl: credential.discoveryUrl,
    clientId,
    clientSecret,
  };

  try {
    const exists = await oAuth2ProviderExists(client, credential.name);

    if (exists) {
      const updateResult = await updateOAuth2Provider(client, params);
      return {
        providerName: credential.name,
        status: updateResult.success ? 'updated' : 'error',
        error: updateResult.error,
        credentialProviderArn: updateResult.result?.credentialProviderArn,
        clientSecretArn: updateResult.result?.clientSecretArn,
        callbackUrl: updateResult.result?.callbackUrl,
      };
    }

    const createResult = await createOAuth2Provider(client, params);
    return {
      providerName: credential.name,
      status: createResult.success ? 'created' : 'error',
      error: createResult.error,
      credentialProviderArn: createResult.result?.credentialProviderArn,
      clientSecretArn: createResult.result?.clientSecretArn,
      callbackUrl: createResult.result?.callbackUrl,
    };
  } catch (error) {
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = 'AWS credentials not found. Run `aws sso login` or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.';
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    return { providerName: credential.name, status: 'error', error: errorMessage };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Credential Providers
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentCredentialProviderResult {
  credentialProviderArn: string;
  credentialProviderName: string;
}

export interface PaymentCredentialProvidersResult {
  credentialProviders: Record<string, PaymentCredentialProviderResult>;
  hasErrors: boolean;
  errors: string[];
}

export interface SetupPaymentCredentialProvidersOptions {
  projectSpec: AgentCoreProjectSpec;
  configBaseDir: string;
  region: string;
  runtimeCredentials?: SecureCredentials;
}

export function hasPaymentCredentialProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return (projectSpec.payments ?? []).length > 0;
}

export async function setupPaymentCredentialProviders(
  options: SetupPaymentCredentialProvidersOptions
): Promise<PaymentCredentialProvidersResult> {
  const { projectSpec, configBaseDir, region, runtimeCredentials } = options;

  const result: PaymentCredentialProvidersResult = {
    credentialProviders: {},
    hasErrors: false,
    errors: [],
  };

  if ((projectSpec.payments ?? []).length === 0) {
    return result;
  }

  // The unified .env.local check runs at the top of the deploy flow (assertEnvFileExists).
  // By the time we get here, the file exists; per-var validation below catches empty values.

  const envVars = await readEnvFile(configBaseDir);
  const envCredentials = SecureCredentials.fromEnvVars(envVars);
  const allCredentials = runtimeCredentials ? envCredentials.merge(runtimeCredentials) : envCredentials;

  for (const payment of projectSpec.payments ?? []) {
    for (const connector of payment.connectors) {
      try {
        const credentialName = connector.credentialName;
        const credential = projectSpec.credentials.find(
          c => c.name === credentialName && c.authorizerType === 'PaymentCredentialProvider'
        );
        if (!credential) {
          result.hasErrors = true;
          result.errors.push(
            `Payment manager "${payment.name}" connector "${connector.name}" references credential "${credentialName}" which is not a PaymentCredentialProvider`
          );
          continue;
        }

        const credentialProviderArn = await createOrUpdatePaymentCredentialProvider({
          connector,
          credential,
          region,
          credentials: allCredentials,
        });

        result.credentialProviders[credentialName] = {
          credentialProviderArn,
          credentialProviderName: credentialName,
        };
      } catch (error) {
        let errorMessage: string;
        if (isNoCredentialsError(error)) {
          errorMessage = `AWS credentials not found. ${await getAwsLoginGuidance()}`;
        } else if (isQuotaExceededError(error)) {
          errorMessage = `Service quota exceeded. Delete unused credential providers, or request a limit increase via the AWS Service Quotas console.`;
        } else {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        result.hasErrors = true;
        result.errors.push(`Credential provider for "${connector.name}": ${errorMessage}`);
      }
    }
  }

  return result;
}

export async function cleanupPaymentCredentialProviders(options: {
  region: string;
  payments: Record<string, { connectors?: Record<string, { credentialProviderArn: string }> }>;
}): Promise<void> {
  const { region, payments } = options;

  for (const [name, state] of Object.entries(payments)) {
    for (const [connName, conn] of Object.entries(state.connectors ?? {})) {
      const credName = conn.credentialProviderArn.split('/').pop() ?? '';
      if (credName) {
        try {
          await deletePaymentCredentialProvider({ region, name: credName });
        } catch (credErr) {
          const msg = credErr instanceof Error ? credErr.message : String(credErr);
          if (!msg.includes('404') && !msg.includes('NotFound')) {
            console.warn(
              `Failed to delete credential provider for connector '${connName}' (payment '${name}'): ${msg}`
            );
          }
        }
      }
    }
  }
}

// ── Payment Credential Provider Helper ────────────────────────────────────

interface CreateOrUpdatePaymentCredentialProviderOptions {
  connector: NonNullable<AgentCoreProjectSpec['payments']>[number]['connectors'][number];
  credential: AgentCoreProjectSpec['credentials'][number];
  region: string;
  credentials: SecureCredentials;
}

async function createOrUpdatePaymentCredentialProvider(
  options: CreateOrUpdatePaymentCredentialProviderOptions
): Promise<string> {
  const { connector, credential, region, credentials } = options;
  const vendor = connector.provider ?? 'CoinbaseCDP';

  let credProviderOptions: Parameters<typeof createPaymentCredentialProvider>[0];

  if (vendor === 'StripePrivy') {
    const envVarNames = computeStripePrivyCredentialEnvVarNames(credential.name);
    const appId = credentials.get(envVarNames.appId);
    const appSecret = credentials.get(envVarNames.appSecret);
    const authorizationPrivateKey = credentials.get(envVarNames.authorizationPrivateKey);
    const authorizationId = credentials.get(envVarNames.authorizationId);

    if (!appId || !appSecret || !authorizationPrivateKey || !authorizationId) {
      const missing = [
        !appId && envVarNames.appId,
        !appSecret && envVarNames.appSecret,
        !authorizationPrivateKey && envVarNames.authorizationPrivateKey,
        !authorizationId && envVarNames.authorizationId,
      ].filter(Boolean);
      throw new Error(
        `Missing StripePrivy credentials for connector "${connector.name}" in agentcore/.env.local: ${missing.join(', ')}`
      );
    }

    credProviderOptions = {
      region,
      name: credential.name,
      vendor: 'StripePrivy',
      appId,
      appSecret,
      authorizationPrivateKey,
      authorizationId,
    };
  } else {
    const envVarNames = computePaymentCredentialEnvVarNames(credential.name);
    const apiKeyId = credentials.get(envVarNames.apiKeyId);
    const apiKeySecret = credentials.get(envVarNames.apiKeySecret);
    const walletSecret = credentials.get(envVarNames.walletSecret);

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      const missing = [
        !apiKeyId && envVarNames.apiKeyId,
        !apiKeySecret && envVarNames.apiKeySecret,
        !walletSecret && envVarNames.walletSecret,
      ].filter(Boolean);
      throw new Error(
        `Missing CDP credentials for connector "${connector.name}" in agentcore/.env.local: ${missing.join(', ')}`
      );
    }

    credProviderOptions = {
      region,
      name: credential.name,
      vendor: 'CoinbaseCDP',
      apiKeyId,
      apiKeySecret,
      walletSecret,
    };
  }

  const existingProvider = await getPaymentCredentialProvider({ region, name: credential.name });
  if (existingProvider) {
    const updateResult = await updatePaymentCredentialProvider(credProviderOptions);
    return updateResult.credentialProviderArn;
  }
  const createResult = await createPaymentCredentialProvider(credProviderOptions);
  return createResult.credentialProviderArn;
}
