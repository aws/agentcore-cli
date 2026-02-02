import { SecureCredentials, readEnvFile } from '../../../lib';
import type { AgentCoreProjectSpec, AgentEnvSpec, OwnedIdentityProvider } from '../../../schema';
import { getCredentialProvider } from '../../aws';
import { isNoCredentialsError } from '../../errors';
import { apiKeyProviderExists, createApiKeyProvider, setTokenVaultKmsKey } from '../identity';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeyProviderSetupResult {
  agentName: string;
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
 * Set up API key credential providers for all owned identity providers.
 * Reads API keys from agentcore/.env.local (keyed by envVarName) and creates providers in AgentCore Identity.
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
  if (enableKmsEncryption || projectSpec.identityKmsKeyArn) {
    const kmsResult = await setupTokenVaultKms(region, credentials, projectSpec);
    if (!kmsResult.success) {
      return {
        results: [
          {
            agentName: '',
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

  for (const agent of projectSpec.agents) {
    const agentResults = await setupAgentIdentityProviders(client, agent, allCredentials);
    results.push(...agentResults);
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
    let keyArn = projectSpec.identityKmsKeyArn;

    // Create KMS key if not provided
    if (!keyArn) {
      const kmsClient = new KMSClient({ region, credentials });
      const response = await kmsClient.send(
        new CreateKeyCommand({
          Description: `AgentCore Identity encryption key for ${projectSpec.name}`,
          Tags: [{ TagKey: 'agentcore:project', TagValue: projectSpec.name }],
        })
      );
      keyArn = response.KeyMetadata?.Arn;
      if (!keyArn) {
        return { success: false, error: 'Failed to create KMS key' };
      }
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

async function setupAgentIdentityProviders(
  client: BedrockAgentCoreControlClient,
  agent: AgentEnvSpec,
  credentials: SecureCredentials
): Promise<ApiKeyProviderSetupResult[]> {
  const results: ApiKeyProviderSetupResult[] = [];

  const ownedProviders = agent.identityProviders.filter((p): p is OwnedIdentityProvider => p.relation === 'own');

  for (const provider of ownedProviders) {
    if (provider.variant === 'ApiKeyCredentialProvider') {
      const result = await setupApiKeyCredentialProvider(client, agent.name, provider, credentials);
      results.push(result);
    }
  }

  return results;
}

async function setupApiKeyCredentialProvider(
  client: BedrockAgentCoreControlClient,
  agentName: string,
  provider: OwnedIdentityProvider,
  credentials: SecureCredentials
): Promise<ApiKeyProviderSetupResult> {
  // envVarName is the SOT - read API key from secure credentials using this key
  const apiKey = credentials.get(provider.envVarName);

  if (!apiKey) {
    return {
      agentName,
      providerName: provider.name,
      status: 'skipped',
      error: `No ${provider.envVarName} found in agentcore/.env.local`,
    };
  }

  try {
    const exists = await apiKeyProviderExists(client, provider.name);
    if (exists) {
      return { agentName, providerName: provider.name, status: 'exists' };
    }

    const createResult = await createApiKeyProvider(client, provider.name, apiKey);
    return {
      agentName,
      providerName: provider.name,
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
      agentName,
      providerName: provider.name,
      status: 'error',
      error: errorMessage,
    };
  }
}

/**
 * Check if any agents have owned API key identity providers that need setup.
 */
export function hasOwnedIdentityApiProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.agents.some(agent =>
    agent.identityProviders.some(p => p.relation === 'own' && p.variant === 'ApiKeyCredentialProvider')
  );
}

export interface MissingCredential {
  providerName: string;
  envVarName: string;
  agentName: string;
}

/**
 * Get list of identity providers that are missing API keys in .env.local.
 */
export async function getMissingCredentials(
  projectSpec: AgentCoreProjectSpec,
  configBaseDir: string
): Promise<MissingCredential[]> {
  const envVars = await readEnvFile(configBaseDir);
  const missing: MissingCredential[] = [];

  for (const agent of projectSpec.agents) {
    const ownedProviders = agent.identityProviders.filter(
      (p): p is OwnedIdentityProvider => p.relation === 'own' && p.variant === 'ApiKeyCredentialProvider'
    );

    for (const provider of ownedProviders) {
      if (!envVars[provider.envVarName]) {
        missing.push({
          providerName: provider.name,
          envVarName: provider.envVarName,
          agentName: agent.name,
        });
      }
    }
  }

  return missing;
}
