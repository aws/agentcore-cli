import { ConfigIO, getEnvVar, setEnvVar } from '../../../lib';
import type { Credential, ModelProvider } from '../../../schema';

/**
 * Config for creating a credential resource.
 */
export interface CreateCredentialConfig {
  name: string;
  apiKey: string;
}

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
  return `AGENTCORE_CREDENTIAL_${credentialName.toUpperCase()}`;
}

/**
 * Resolve credential strategy for adding an agent.
 * Determines whether to reuse existing credential or create new one.
 *
 * Logic:
 * - Bedrock uses IAM, no credential needed
 * - No API key provided, no credential needed
 * - No existing credential for provider → create project-scoped
 * - Existing credential but can't read key → create project-scoped (treat as fresh)
 * - Existing credential with matching key → reuse
 * - Existing credential with different key → create agent-scoped
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

  // Check for existing project-scoped credential
  const projectScopedName = `${projectName}${modelProvider}`;
  const existingCredential = existingCredentials.find(c => c.name === projectScopedName);

  if (!existingCredential) {
    // First agent with this provider - create project-scoped credential
    const envVarName = computeDefaultCredentialEnvVarName(projectScopedName);
    return { reuse: false, credentialName: projectScopedName, envVarName, isAgentScoped: false };
  }

  // Credential exists - compare API keys
  const existingEnvVarName = computeDefaultCredentialEnvVarName(projectScopedName);
  const existingApiKey = await getEnvVar(existingEnvVarName, configBaseDir);

  if (existingApiKey === undefined) {
    // Can't read existing key - treat as no existing credential
    return { reuse: false, credentialName: projectScopedName, envVarName: existingEnvVarName, isAgentScoped: false };
  }

  if (existingApiKey === newApiKey) {
    // Same key - reuse existing credential
    return { reuse: true, credentialName: projectScopedName, envVarName: existingEnvVarName, isAgentScoped: false };
  }

  // Different key - create agent-scoped credential
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
 * Create a credential resource and add it to the project.
 * Also writes the API key to the .env file.
 *
 * If the credential already exists (e.g., created during agent generation),
 * just updates the API key in the .env file.
 */
export async function createCredential(config: CreateCredentialConfig): Promise<Credential> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  // Check if credential already exists
  const existingCredential = project.credentials.find(c => c.name === config.name);

  let credential: Credential;
  if (existingCredential) {
    // updates credentital
    credential = existingCredential;
  } else {
    // Create new credential entry
    credential = {
      type: 'ApiKeyCredentialProvider',
      name: config.name,
    };
    project.credentials.push(credential);
    await configIO.writeProjectSpec(project);
  }

  // Write API key to .env file
  const envVarName = computeDefaultCredentialEnvVarName(config.name);
  await setEnvVar(envVarName, config.apiKey);

  return credential;
}
