import { SecureCredentials, readEnvFile } from '../../../lib';
import type { AgentCoreProjectSpec, Credential } from '../../../schema';
import { getCredentialProvider } from '../../aws';
import { isNoCredentialsError } from '../../errors';
import { apiKeyProviderExists, createApiKeyProvider, setTokenVaultKmsKey } from '../identity';
import { computeDefaultCredentialEnvVarName } from '../identity/create-identity';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeyProviderSetupResult {
  providerName: string;
  status: 'created' | 'exists' | 'skipped' | 'error';
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
    if (credential.type === 'ApiKeyCredentialProvider') {
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
    // Create KMS key for this project
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

    // Configure token vault to use the key
    const client = new BedrockAgentCoreControlClient({ region, credentials });
    const result = await setTokenVaultKmsKey(client, keyArn);
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
      return { providerName: credential.name, status: 'exists' };
    }

    const createResult = await createApiKeyProvider(client, credential.name, apiKey);
    return {
      providerName: credential.name,
      status: createResult.success ? 'created' : 'error',
      error: createResult.error,
    };
  } catch (error) {
    // Provide clearer error message for AWS credentials issues
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = 'AWS credentials not found. Run `aws sso login` or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.';
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
export function hasOwnedIdentityApiProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.credentials.some(c => c.type === 'ApiKeyCredentialProvider');
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
    if (credential.type === 'ApiKeyCredentialProvider') {
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
