import {
  ConflictError,
  ResourceNotFoundError,
  findConfigRoot,
  getEnvVar,
  serializeResult,
  setEnvVar,
  toError,
} from '../../lib';
import type { Result } from '../../lib/result';
import type { Credential, ModelProvider } from '../../schema';
import { CredentialSchema } from '../../schema';
import { validateAddCredentialOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { CredentialType, standardize } from '../telemetry/schemas/common-shapes.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import { computeDefaultCredentialEnvVarName } from './credential-utils';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding an API Key credential.
 */
export interface AddApiKeyCredentialOptions {
  authorizerType: 'ApiKeyCredentialProvider';
  name: string;
  apiKey: string;
}

/**
 * Options for adding an OAuth credential.
 */
export interface AddOAuthCredentialOptions {
  authorizerType: 'OAuthCredentialProvider';
  name: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/**
 * Options for adding a credential resource.
 * Union type supporting both API Key and OAuth credential configurations.
 */
export type AddCredentialOptions = AddApiKeyCredentialOptions | AddOAuthCredentialOptions;

/**
 * Represents a credential that can be removed.
 */
export interface RemovableCredential extends RemovableResource {
  name: string;
  authorizerType: string;
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
 * CredentialPrimitive handles all credential add/remove operations.
 * Absorbs logic from create-identity.ts and remove-identity.ts.
 */
export class CredentialPrimitive extends BasePrimitive<AddCredentialOptions, RemovableCredential> {
  readonly kind = 'credential';
  readonly label = 'Credential';
  readonly primitiveSchema = CredentialSchema;

  protected override readonly article: string = 'a';

  async add(options: AddCredentialOptions): Promise<AddResult<{ credentialName: string }>> {
    try {
      const credential = await this.createCredential(options);
      return { success: true, credentialName: credential.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(credentialName: string, options?: { force?: boolean }): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const credentialIndex = project.credentials.findIndex(c => c.name === credentialName);
      if (credentialIndex === -1) {
        return { success: false, error: new ResourceNotFoundError(`Credential "${credentialName}" not found.`) };
      }

      const credential = project.credentials[credentialIndex]!;

      // Block removal of managed credentials unless force is passed
      if ('managed' in credential && credential.managed && !options?.force) {
        return {
          success: false,
          error: new ConflictError(
            `Credential "${credentialName}" is managed by the CLI and cannot be removed. Use force to override.`
          ),
        };
      }

      // Warn about gateway targets referencing this credential
      const referencingTargets = await this.findReferencingGatewayTargets(credentialName);
      if (referencingTargets.length > 0 && !options?.force) {
        const targetList = referencingTargets.map(t => t.name).join(', ');
        return {
          success: false,
          error: new ConflictError(
            `Credential "${credentialName}" is referenced by gateway target(s): ${targetList}. Use force to override.`
          ),
        };
      }

      project.credentials.splice(credentialIndex, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(credentialName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const credential = project.credentials.find(c => c.name === credentialName);
    if (!credential) {
      throw new Error(`Credential "${credentialName}" not found.`);
    }

    const summary: string[] = [
      `Removing credential: ${credentialName}`,
      `Type: ${credential.authorizerType}`,
      `Note: .env file will not be modified`,
    ];

    // Warn if this is a managed credential
    if ('managed' in credential && credential.managed) {
      summary.push(`Warning: This credential is managed by the CLI. Removing it may break gateway authentication.`);
    }

    // Warn about gateway targets that reference this credential
    const referencingTargets = await this.findReferencingGatewayTargets(credentialName);
    if (referencingTargets.length > 0) {
      const targetList = referencingTargets.map(t => t.name).join(', ');
      summary.push(`Warning: Referenced by gateway target(s): ${targetList}`);
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

  async getRemovable(): Promise<RemovableCredential[]> {
    try {
      const project = await this.readProjectSpec();
      return project.credentials.map(c => ({ name: c.name, authorizerType: c.authorizerType }));
    } catch {
      return [];
    }
  }

  /**
   * Get all credentials as full Credential objects.
   */
  async getAllCredentials(): Promise<Credential[]> {
    try {
      const project = await this.readProjectSpec();
      return project.credentials;
    } catch {
      return [];
    }
  }

  /**
   * Get list of existing credential names.
   */
  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.configIO.readProjectSpec();
      return project.credentials.map(c => c.name);
    } catch {
      return [];
    }
  }

  static computeDefaultCredentialEnvVarName = computeDefaultCredentialEnvVarName;

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
  async resolveCredentialStrategy(
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
      const envVarName = CredentialPrimitive.computeDefaultCredentialEnvVarName(cred.name);
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
      const envVarName = CredentialPrimitive.computeDefaultCredentialEnvVarName(projectScopedName);
      return { reuse: false, credentialName: projectScopedName, envVarName, isAgentScoped: false };
    }

    // Project-scoped exists with different key - create agent-scoped
    const agentScopedName = `${projectName}${agentName}${modelProvider}`;
    const agentScopedEnvVarName = CredentialPrimitive.computeDefaultCredentialEnvVarName(agentScopedName);
    return { reuse: false, credentialName: agentScopedName, envVarName: agentScopedEnvVarName, isAgentScoped: true };
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('credential')
      .description('Add a credential to the project')
      .option('--name <name>', 'Credential name [non-interactive]')
      .option('--api-key <key>', 'The API key value [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .option('--type <type>', 'Credential type: api-key (default) or oauth [non-interactive]')
      .option('--discovery-url <url>', 'OAuth discovery URL [non-interactive]')
      .option('--client-id <id>', 'OAuth client ID [non-interactive]')
      .option('--client-secret <secret>', 'OAuth client secret [non-interactive]')
      .option('--scopes <scopes>', 'OAuth scopes, comma-separated [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          apiKey?: string;
          json?: boolean;
          type?: string;
          discoveryUrl?: string;
          clientId?: string;
          clientSecret?: string;
          scopes?: string;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (
            cliOptions.name ||
            cliOptions.apiKey ||
            cliOptions.json ||
            cliOptions.type ||
            cliOptions.discoveryUrl ||
            cliOptions.clientId ||
            cliOptions.clientSecret ||
            cliOptions.scopes
          ) {
            // CLI mode
            await runCliCommand('add.credential', !!cliOptions.json, async () => {
              const validation = validateAddCredentialOptions({
                name: cliOptions.name,
                type: cliOptions.type as 'api-key' | 'oauth' | undefined,
                apiKey: cliOptions.apiKey,
                discoveryUrl: cliOptions.discoveryUrl,
                clientId: cliOptions.clientId,
                clientSecret: cliOptions.clientSecret,
                scopes: cliOptions.scopes,
              });

              if (!validation.valid) {
                throw new Error(validation.error);
              }

              const addOptions =
                cliOptions.type === 'oauth'
                  ? {
                      authorizerType: 'OAuthCredentialProvider' as const,
                      name: cliOptions.name!,
                      discoveryUrl: cliOptions.discoveryUrl!,
                      clientId: cliOptions.clientId!,
                      clientSecret: cliOptions.clientSecret!,
                      scopes: cliOptions.scopes
                        ?.split(',')
                        .map(s => s.trim())
                        .filter(Boolean),
                    }
                  : {
                      authorizerType: 'ApiKeyCredentialProvider' as const,
                      name: cliOptions.name!,
                      apiKey: cliOptions.apiKey!,
                    };

              const result = await this.add(addOptions);

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added credential '${result.credentialName}'`);
              }

              return {
                credential_type: standardize(CredentialType, cliOptions.type ?? 'api-key'),
              };
            });
          } else {
            try {
              // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'credential',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            } catch (error) {
              console.error(getErrorMessage(error));
              process.exit(1);
            }
          }
        }
      );

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Core credential creation logic (absorbed from create-identity.ts).
   * Creates credential in project config and writes secrets to .env.
   */
  private async createCredential(config: AddCredentialOptions): Promise<Credential> {
    const project = await this.readProjectSpec();

    // Check if credential already exists
    const existingCredential = project.credentials.find(c => c.name === config.name);

    let credential: Credential;
    if (existingCredential) {
      credential = existingCredential;
    } else if (config.authorizerType === 'OAuthCredentialProvider') {
      credential = {
        authorizerType: 'OAuthCredentialProvider',
        name: config.name,
        discoveryUrl: config.discoveryUrl,
        vendor: 'CustomOauth2',
        scopes: config.scopes,
      };
      project.credentials.push(credential);
      await this.writeProjectSpec(project);
    } else {
      credential = {
        authorizerType: 'ApiKeyCredentialProvider',
        name: config.name,
      };
      project.credentials.push(credential);
      await this.writeProjectSpec(project);
    }

    // Write secrets to .env file
    if (config.authorizerType === 'OAuthCredentialProvider') {
      const clientIdEnvVar = `${CredentialPrimitive.computeDefaultCredentialEnvVarName(config.name)}_CLIENT_ID`;
      const clientSecretEnvVar = `${CredentialPrimitive.computeDefaultCredentialEnvVarName(config.name)}_CLIENT_SECRET`;
      await setEnvVar(clientIdEnvVar, config.clientId);
      await setEnvVar(clientSecretEnvVar, config.clientSecret);
    } else {
      const envVarName = CredentialPrimitive.computeDefaultCredentialEnvVarName(config.name);
      await setEnvVar(envVarName, config.apiKey);
    }

    return credential;
  }

  /**
   * Find gateway targets that reference the given credential via outboundAuth.
   * Returns an array of target objects with a `name` field, or empty if project spec can't be read.
   */
  private async findReferencingGatewayTargets(credentialName: string): Promise<{ name: string }[]> {
    let project;
    try {
      project = await this.readProjectSpec();
    } catch {
      return [];
    }

    const referencingTargets: { name: string }[] = [];
    for (const gateway of project.agentCoreGateways) {
      for (const target of gateway.targets) {
        if (target.outboundAuth?.credentialName === credentialName) {
          referencingTargets.push({ name: target.name });
        }
      }
    }

    return referencingTargets;
  }
}
