import { ConfigIO, setEnvVar } from '../../../lib';
import type { IdentityCredentialVariant, OwnedIdentityProvider, ReferencedIdentityProvider } from '../../../schema';
import type { AddIdentityConfig } from '../../tui/screens/identity/types';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Identity Builders (SOT for identity provider creation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the qualified provider name for AWS resources.
 * Format: {projectName}{providerName} (no separator to comply with alphanumeric-only schema)
 * This ensures provider names are unique per project.
 */
export function computeQualifiedProviderName(projectName: string, providerName: string): string {
  return `${projectName}${providerName}`;
}

/**
 * Compute the default runtime env var name for an identity provider.
 * Pattern: AGENTCORE_IDENTITY_{NAME}
 */
export function computeDefaultIdentityEnvVarName(providerName: string): string {
  return `AGENTCORE_IDENTITY_${providerName.toUpperCase()}`;
}

/**
 * Build an owned identity provider object.
 * Used by both add agent and add identity flows.
 * @param providerName - Simple provider name (e.g., "OpenAI")
 * @param projectName - Project name for creating qualified AWS resource name
 * @param variant - Identity credential variant
 */
export function buildOwnedIdentityProvider(
  providerName: string,
  projectName: string,
  variant: IdentityCredentialVariant = 'ApiKeyCredentialProvider'
): OwnedIdentityProvider {
  // Qualified name is used for AWS resource naming (unique per project)
  const qualifiedName = computeQualifiedProviderName(projectName, providerName);
  return {
    type: 'AgentCoreIdentity',
    variant,
    relation: 'own',
    name: qualifiedName,
    description: `API key credential provider for ${providerName}`,
    envVarName: computeDefaultIdentityEnvVarName(providerName),
  };
}

/**
 * Build a referenced identity provider object (for agents that use but don't own).
 * @param providerName - Simple provider name (e.g., "OpenAI")
 * @param projectName - Project name for creating qualified AWS resource name
 * @param variant - Identity credential variant
 */
export function buildReferencedIdentityProvider(
  providerName: string,
  projectName: string,
  variant: IdentityCredentialVariant = 'ApiKeyCredentialProvider'
): ReferencedIdentityProvider {
  // Qualified name is used for AWS resource naming (unique per project)
  const qualifiedName = computeQualifiedProviderName(projectName, providerName);
  return {
    type: 'AgentCoreIdentity',
    variant,
    relation: 'use',
    name: qualifiedName,
    description: `API key credential provider for ${providerName}`,
    envVarName: computeDefaultIdentityEnvVarName(providerName),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Identity Flow
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateIdentityResult {
  name: string;
  ownerAgent: string;
  userAgents: string[];
}

/**
 * Get list of existing identity provider names across all agents.
 */
export async function getAllIdentityNames(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    const names: string[] = [];
    for (const agent of project.agents) {
      for (const identity of agent.identityProviders) {
        if (!names.includes(identity.name)) {
          names.push(identity.name);
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Create an identity provider and attach it to agents.
 * Owner agent gets relation: 'own', user agents get relation: 'use'.
 */
export async function createIdentityFromWizard(config: AddIdentityConfig): Promise<CreateIdentityResult> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  // Compute qualified name for AWS resource (unique per project)
  const qualifiedName = computeQualifiedProviderName(project.name, config.name);

  // Add owned identity provider to owner agent
  const ownerAgent = project.agents.find(a => a.name === config.ownerAgent);
  if (!ownerAgent) {
    throw new Error(`Owner agent "${config.ownerAgent}" not found in agentcore.json.`);
  }

  if (ownerAgent.identityProviders.some(p => p.name === qualifiedName)) {
    throw new Error(`Identity provider "${config.name}" already exists on agent "${config.ownerAgent}".`);
  }

  ownerAgent.identityProviders.push(buildOwnedIdentityProvider(config.name, project.name, config.identityType));

  // Add referenced identity provider to user agents
  for (const userAgentName of config.userAgents) {
    const userAgent = project.agents.find(a => a.name === userAgentName);
    if (!userAgent) {
      throw new Error(`User agent "${userAgentName}" not found in agentcore.json.`);
    }

    if (userAgent.identityProviders.some(p => p.name === qualifiedName)) {
      throw new Error(`Identity provider "${config.name}" already exists on agent "${userAgentName}".`);
    }

    userAgent.identityProviders.push(buildReferencedIdentityProvider(config.name, project.name, config.identityType));
  }

  // Write updated project spec
  await configIO.writeProjectSpec(project);

  // Write API key to .env file
  const envVarName = computeDefaultIdentityEnvVarName(config.name);
  await setEnvVar(envVarName, config.apiKey);

  return {
    name: qualifiedName,
    ownerAgent: config.ownerAgent,
    userAgents: config.userAgents,
  };
}
