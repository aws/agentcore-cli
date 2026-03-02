import { ConfigIO } from '../../../lib';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';

/**
 * Represents a credential that can be removed.
 */
export interface RemovableCredential {
  name: string;
  type: string;
}

// Alias for hooks expecting old name
export type RemovableIdentity = RemovableCredential;

/**
 * Get list of credentials available for removal.
 */
export async function getRemovableCredentials(): Promise<RemovableCredential[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.credentials.map(c => ({ name: c.name, type: c.type }));
  } catch {
    return [];
  }
}

/**
 * Preview what will be removed when removing a credential.
 */
export async function previewRemoveCredential(credentialName: string): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  const credential = project.credentials.find(c => c.name === credentialName);
  if (!credential) {
    throw new Error(`Credential "${credentialName}" not found.`);
  }

  const summary: string[] = [
    `Removing credential: ${credentialName}`,
    `Type: ${credential.type}`,
    `Note: .env file will not be modified`,
  ];

  if ('managed' in credential && credential.managed) {
    summary.push(
      `⚠️  Warning: This credential was auto-created for CUSTOM_JWT gateway auth. Removing it will break agent authentication.`
    );
  }

  // Check for references in gateway targets
  const referencingTargets: string[] = [];
  try {
    if (configIO.configExists('mcp')) {
      const mcpSpec = await configIO.readMcpSpec();
      for (const gateway of mcpSpec.agentCoreGateways) {
        for (const target of gateway.targets) {
          if (target.outboundAuth?.credentialName === credentialName) {
            referencingTargets.push(`${gateway.name}/${target.name}`);
          }
        }
      }
    }
  } catch {
    // MCP config doesn't exist or is invalid - no references to check
  }

  if (referencingTargets.length > 0) {
    summary.push(
      `Warning: Credential "${credentialName}" is referenced by gateway targets: ${referencingTargets.join(', ')}. Removing it may break these targets.`
    );
  }

  const schemaChanges: SchemaChange[] = [];

  const afterSpec = {
    ...project,
    credentials: project.credentials.filter(c => c.name !== credentialName),
  };

  schemaChanges.push({
    file: 'agentcore/agentcore.json',
    before: project,
    after: afterSpec,
  });

  return { summary, directoriesToDelete: [], schemaChanges };
}

/**
 * Remove a credential from the project.
 */
export async function removeCredential(credentialName: string, options?: { force?: boolean }): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();

    const credentialIndex = project.credentials.findIndex(c => c.name === credentialName);
    if (credentialIndex === -1) {
      return { ok: false, error: `Credential "${credentialName}" not found.` };
    }

    const credential = project.credentials[credentialIndex];

    // Block removal of managed credentials unless --force is used
    if (credential && 'managed' in credential && credential.managed && !options?.force) {
      return {
        ok: false,
        error: `Credential "${credentialName}" was auto-created for CUSTOM_JWT gateway auth. Use --force to remove it.`,
      };
    }

    // Check for references in gateway targets and warn
    const referencingTargets: string[] = [];
    try {
      if (configIO.configExists('mcp')) {
        const mcpSpec = await configIO.readMcpSpec();
        for (const gateway of mcpSpec.agentCoreGateways) {
          for (const target of gateway.targets) {
            if (target.outboundAuth?.credentialName === credentialName) {
              referencingTargets.push(`${gateway.name}/${target.name}`);
            }
          }
        }
      }
    } catch {
      // MCP config doesn't exist or is invalid - no references to check
    }

    if (referencingTargets.length > 0) {
      console.warn(
        `Warning: Credential "${credentialName}" is referenced by gateway targets: ${referencingTargets.join(', ')}. Removing it may break these targets.`
      );
    }

    project.credentials.splice(credentialIndex, 1);
    await configIO.writeProjectSpec(project);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}

// Function aliases for hooks expecting old names
export const getRemovableIdentities = getRemovableCredentials;
export const previewRemoveIdentity = previewRemoveCredential;
export const removeIdentity = removeCredential;
