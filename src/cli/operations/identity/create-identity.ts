import { ConfigIO, setEnvVar } from '../../../lib';
import type { Credential } from '../../../schema';

/**
 * Config for creating a credential resource.
 */
export interface CreateCredentialConfig {
  name: string;
  apiKey: string;
}

/**
 * Compute the default env var name for a credential.
 */
export function computeDefaultCredentialEnvVarName(credentialName: string): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.toUpperCase()}`;
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
