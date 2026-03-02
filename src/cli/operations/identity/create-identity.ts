import { ConfigIO, getEnvVar, setEnvVar } from '../../../lib';
import type { Credential, ModelProvider } from '../../../schema';

/**
 * Config for creating a credential resource.
 */
export type CreateCredentialConfig =
  | { type: 'ApiKeyCredentialProvider'; name: string; apiKey: string }
  | {
      type: 'OAuthCredentialProvider';
      name: string;
      discoveryUrl: string;
      clientId: string;
      clientSecret: string;
      scopes?: string[];
      vendor?: string;
      managed?: boolean;
    };

/**
 * Result of resolving credential strategy for an agent.
 */
export interface CredentialStrategy {
  /** True if reusing existing credential, false if creating new */
  reuse: boolean;
  /** Credential name to use (empty string if no credential needed) */
  credentialName: string;
  /** Environment variable name for the API key */
  envVarName: string;
  /** True if this is an agent-scoped credential */
  isAgentScoped: boolean;
}

/**
 * Compute the default env var name for a credential.
 */
export function computeDefaultCredentialEnvVarName(credentialName: string): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Resolve credential strategy for adding an agent.
 * Determines whether to reuse existing credential or create new one.
 *
 * Logic:
 * - Bedrock uses IAM, no credential needed
 * - No API key provided, no credential needed
 * - No existing credential for provider → create project-scoped
 * - Any existing credential with matching key → reuse it
 * - No matching key → create agent-scoped (or project-scoped if first)
 */
export async function resolveCredentialStrategy(
  projectName: string,
  agentName: string,
  modelProvider: ModelProvider,
  newApiKey: string | undefined,
  configBaseDir: string,
  existingCredentials: Credential[]
): Promise<CredentialStrategy> {
  // Bedrock uses IAM, no credential needed
  if (modelProvider === 'Bedrock') {
    return { reuse: true, credentialName: '', envVarName: '', isAgentScoped: false };
  }

  // No API key provided, no credential needed
  if (!newApiKey) {
    return { reuse: true, credentialName: '', envVarName: '', isAgentScoped: false };
  }

  // Check ALL existing credentials for a matching API key
  for (const cred of existingCredentials) {
    const envVarName = computeDefaultCredentialEnvVarName(cred.name);
    const existingApiKey = await getEnvVar(envVarName, configBaseDir);
    if (existingApiKey === newApiKey) {
      const isAgentScoped = cred.name !== `${projectName}${modelProvider}`;
      return { reuse: true, credentialName: cred.name, envVarName, isAgentScoped };
    }
  }

  // No matching key found - create new credential
  const projectScopedName = `${projectName}${modelProvider}`;
  const hasProjectScoped = existingCredentials.some(c => c.name === projectScopedName);

  if (!hasProjectScoped) {
    // First agent with this provider - create project-scoped
    const envVarName = computeDefaultCredentialEnvVarName(projectScopedName);
    return { reuse: false, credentialName: projectScopedName, envVarName, isAgentScoped: false };
  }

  // Project-scoped exists with different key - create agent-scoped
  const agentScopedName = `${projectName}${agentName}${modelProvider}`;
  const agentScopedEnvVarName = computeDefaultCredentialEnvVarName(agentScopedName);
  return { reuse: false, credentialName: agentScopedName, envVarName: agentScopedEnvVarName, isAgentScoped: true };
}

// Alias for old name
export const computeDefaultIdentityEnvVarName = computeDefaultCredentialEnvVarName;

/**
 * Get list of existing credential names from the project.
 */
export async function getAllCredentialNames(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.credentials.map(c => c.name);
  } catch {
    return [];
  }
}

/**
 * Get list of existing credentials with full type information from the project.
 */
export async function getAllCredentials(): Promise<Credential[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.credentials;
  } catch {
    return [];
  }
}

/**
 * Create a credential resource and add it to the project.
 * Writes the credential config to agentcore.json and secrets to .env.local.
 */
export async function createCredential(config: CreateCredentialConfig): Promise<Credential> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  // Check if credential already exists
  const existingCredential = project.credentials.find(c => c.name === config.name);

  if (config.type === 'OAuthCredentialProvider') {
    if (existingCredential) {
      throw new Error(`Credential "${config.name}" already exists`);
    }

    const credential: Credential = {
      type: 'OAuthCredentialProvider',
      name: config.name,
      discoveryUrl: config.discoveryUrl,
      vendor: config.vendor ?? 'CustomOauth2',
      ...(config.scopes && config.scopes.length > 0 ? { scopes: config.scopes } : {}),
      ...(config.managed ? { managed: true } : {}),
    };
    project.credentials.push(credential);
    await configIO.writeProjectSpec(project);

    // Write client ID and secret to .env.local
    const envBase = computeDefaultCredentialEnvVarName(config.name);
    await setEnvVar(`${envBase}_CLIENT_ID`, config.clientId);
    await setEnvVar(`${envBase}_CLIENT_SECRET`, config.clientSecret);

    return credential;
  }

  // ApiKeyCredentialProvider
  let credential: Credential;
  if (existingCredential) {
    credential = existingCredential;
  } else {
    credential = {
      type: 'ApiKeyCredentialProvider',
      name: config.name,
    };
    project.credentials.push(credential);
    await configIO.writeProjectSpec(project);
  }

  const envVarName = computeDefaultCredentialEnvVarName(config.name);
  await setEnvVar(envVarName, config.apiKey);

  return credential;
}
