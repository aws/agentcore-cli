import { findConfigRoot, removeEnvVars, setEnvVar, toError } from '../../lib';
import type { AgentCoreProjectSpec, PaymentProvider } from '../../schema';
import { PaymentConnectorNameSchema, PaymentConnectorSchema, PaymentProviderSchema } from '../../schema';
import type { RemoveResult } from '../commands/remove/types';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import { computePaymentCredentialEnvVarNames, computeStripePrivyCredentialEnvVarNames } from './credential-utils';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a CoinbaseCDP payment connector.
 */
export interface AddCoinbaseCdpConnectorOptions {
  manager: string;
  name: string;
  provider: 'CoinbaseCDP';
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

/**
 * Options for adding a StripePrivy payment connector.
 */
export interface AddStripePrivyConnectorOptions {
  manager: string;
  name: string;
  provider: 'StripePrivy';
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  authorizationId: string;
}

export type AddPaymentConnectorOptions = AddCoinbaseCdpConnectorOptions | AddStripePrivyConnectorOptions;

/**
 * Removable connector resource with parent manager context.
 */
export interface RemovableConnectorResource extends RemovableResource {
  managerName: string;
}

/**
 * PaymentConnectorPrimitive handles payment connector add/remove operations.
 * Connectors are child resources of a PaymentManager, using composite keys
 * (managerName/connectorName) for removal — following the PolicyPrimitive pattern.
 */
export class PaymentConnectorPrimitive extends BasePrimitive<AddPaymentConnectorOptions, RemovableConnectorResource> {
  readonly kind = 'payment-connector' as const;
  readonly label = 'Payment Connector';
  readonly primitiveSchema = PaymentConnectorSchema;

  async add(
    options: AddPaymentConnectorOptions
  ): Promise<AddResult<{ connectorName: string; managerName: string; credentialName: string }>> {
    try {
      const project = await this.readProjectSpec();
      // payments is optional in the schema; a connector can only attach to an
      // existing manager, so an absent array simply means "manager not found".
      project.payments ??= [];

      const manager = project.payments.find(m => m.name === options.manager);
      if (!manager) {
        return { success: false, error: new Error(`Payment manager "${options.manager}" not found.`) };
      }

      // Check for duplicate connector name within the manager
      if (manager.connectors.some(c => c.name === options.name)) {
        return {
          success: false,
          error: new Error(`Payment connector "${options.name}" already exists in manager "${options.manager}".`),
        };
      }

      // Build a credential name from the connector name (suffix indicates provider)
      const credentialSuffix = options.provider === 'StripePrivy' ? 'stripe-privy' : 'cdp';
      const credentialName = `${options.manager}-${options.name}-${credentialSuffix}`;

      // Check for duplicate credential name
      this.checkDuplicate(project.credentials, credentialName, 'Credential');

      // Create a PaymentCredentialProvider credential entry
      project.credentials.push({
        authorizerType: 'PaymentCredentialProvider',
        name: credentialName,
        provider: options.provider,
      });

      // Write secrets to .env.local BEFORE spec (if this fails, spec is untouched)
      if (options.provider === 'StripePrivy') {
        const envVarNames = computeStripePrivyCredentialEnvVarNames(credentialName);
        await setEnvVar(envVarNames.appId, options.appId);
        await setEnvVar(envVarNames.appSecret, options.appSecret);
        await setEnvVar(envVarNames.authorizationPrivateKey, options.authorizationPrivateKey);
        await setEnvVar(envVarNames.authorizationId, options.authorizationId);
      } else {
        const envVarNames = computePaymentCredentialEnvVarNames(credentialName);
        await setEnvVar(envVarNames.apiKeyId, options.apiKeyId);
        await setEnvVar(envVarNames.apiKeySecret, options.apiKeySecret);
        await setEnvVar(envVarNames.walletSecret, options.walletSecret);
      }

      // Push connector into the manager's connectors array
      manager.connectors.push({
        name: options.name,
        provider: options.provider,
        credentialName,
      });

      await this.writeProjectSpec(project);

      return {
        success: true,
        connectorName: options.name,
        managerName: options.manager,
        credentialName,
      };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  /**
   * Remove a connector by composite key "managerName/connectorName" or by separate arguments.
   * The composite key format is used by getRemovable() and the generic TUI remove flow.
   */
  async remove(nameOrCompositeKey: string, managerName?: string): Promise<RemoveResult> {
    try {
      const project = await this.readProjectSpec();
      project.payments ??= [];

      let resolvedManager: string | undefined = managerName;
      let resolvedConnector: string = nameOrCompositeKey;

      if (!resolvedManager && nameOrCompositeKey.includes('/')) {
        const slashIndex = nameOrCompositeKey.indexOf('/');
        resolvedManager = nameOrCompositeKey.slice(0, slashIndex);
        resolvedConnector = nameOrCompositeKey.slice(slashIndex + 1);
      }

      if (!resolvedManager) {
        // Find which manager contains this connector
        const matchingManagers = project.payments.filter(m => m.connectors.some(c => c.name === resolvedConnector));
        if (matchingManagers.length > 1) {
          return {
            success: false,
            error: new Error(
              `Connector "${resolvedConnector}" exists in multiple managers: ${matchingManagers.map(m => m.name).join(', ')}. Use --manager to specify which one.`
            ),
          };
        }
        if (matchingManagers.length === 1) {
          resolvedManager = matchingManagers[0]!.name;
        }
      }

      for (const manager of project.payments) {
        if (resolvedManager && manager.name !== resolvedManager) continue;

        const connIndex = manager.connectors.findIndex(c => c.name === resolvedConnector);
        if (connIndex !== -1) {
          const connector = manager.connectors[connIndex]!;
          const credentialName = connector.credentialName;

          // Remove connector
          manager.connectors.splice(connIndex, 1);

          // Remove associated credential if no longer referenced
          const stillReferenced = project.payments.some(m =>
            m.connectors.some(c => c.credentialName === credentialName)
          );
          if (!stillReferenced) {
            const credIndex = project.credentials.findIndex(c => c.name === credentialName);
            if (credIndex !== -1) {
              project.credentials.splice(credIndex, 1);
            }
          }

          await this.writeProjectSpec(project);

          // Clean up .env.local secrets (provider-specific)
          if (!stillReferenced) {
            try {
              if (connector.provider === 'StripePrivy') {
                const envVarNames = computeStripePrivyCredentialEnvVarNames(credentialName);
                await removeEnvVars([
                  envVarNames.appId,
                  envVarNames.appSecret,
                  envVarNames.authorizationPrivateKey,
                  envVarNames.authorizationId,
                ]);
              } else {
                const envVarNames = computePaymentCredentialEnvVarNames(credentialName);
                await removeEnvVars([envVarNames.apiKeyId, envVarNames.apiKeySecret, envVarNames.walletSecret]);
              }
            } catch {
              // Best-effort cleanup
            }
          }

          return { success: true };
        }
      }

      return {
        success: false,
        error: new Error(
          `Payment connector "${resolvedConnector}" not found${resolvedManager ? ` in manager "${resolvedManager}"` : ''}.`
        ),
      };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(nameOrCompositeKey: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    project.payments ??= [];

    let targetManager: string | undefined;
    let targetConnector: string = nameOrCompositeKey;

    if (nameOrCompositeKey.includes('/')) {
      const slashIndex = nameOrCompositeKey.indexOf('/');
      targetManager = nameOrCompositeKey.slice(0, slashIndex);
      targetConnector = nameOrCompositeKey.slice(slashIndex + 1);
    }

    if (!targetManager) {
      const matchingManagers = project.payments.filter(m => m.connectors.some(c => c.name === targetConnector));
      if (matchingManagers.length > 1) {
        throw new Error(
          `Connector "${targetConnector}" exists in multiple managers: ${matchingManagers.map(m => m.name).join(', ')}. Use --manager to specify which one.`
        );
      }
      if (matchingManagers.length === 1) {
        targetManager = matchingManagers[0]!.name;
      }
    }

    for (const manager of project.payments) {
      if (targetManager && manager.name !== targetManager) continue;

      const connector = manager.connectors.find(c => c.name === targetConnector);
      if (connector) {
        const summary = [`Removing payment connector: ${targetConnector} (from manager ${manager.name})`];

        const stillReferenced = project.payments.some(m =>
          m.connectors
            .filter(c => !(m.name === manager.name && c.name === targetConnector))
            .some(c => c.credentialName === connector.credentialName)
        );
        if (!stillReferenced) {
          summary.push(`Associated credential "${connector.credentialName}" will also be removed`);
        } else {
          summary.push(`Credential "${connector.credentialName}" is shared and will be kept`);
        }

        const schemaChanges: SchemaChange[] = [];
        const afterSpec: AgentCoreProjectSpec = {
          ...project,
          payments: project.payments.map(m => {
            if (m.name !== manager.name) return m;
            return {
              ...m,
              connectors: m.connectors.filter(c => c.name !== targetConnector),
            };
          }),
        };
        schemaChanges.push({
          file: 'agentcore/agentcore.json',
          before: project,
          after: afterSpec,
        });

        return { summary, directoriesToDelete: [], schemaChanges };
      }
    }

    throw new Error(
      `Payment connector "${targetConnector}" not found${targetManager ? ` in manager "${targetManager}"` : ''}.`
    );
  }

  /**
   * Get all removable connectors across all managers.
   * Returns composite keys "managerName/connectorName" following PolicyPrimitive pattern.
   */
  async getRemovable(): Promise<RemovableConnectorResource[]> {
    try {
      const project = await this.readProjectSpec();
      const resources: RemovableConnectorResource[] = [];

      for (const manager of project.payments ?? []) {
        for (const connector of manager.connectors) {
          resources.push({
            name: `${manager.name}/${connector.name}`,
            managerName: manager.name,
          });
        }
      }

      return resources;
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('payment-connector')
      .description('Add a payment connector to a payment manager')
      .option('--manager <name>', 'Payment manager name [non-interactive]')
      .option('--name <name>', 'Payment connector name [non-interactive]')
      .option('--provider <provider>', 'Payment provider: CoinbaseCDP, StripePrivy [non-interactive]')
      .option('--api-key-id <id>', 'CDP API Key ID (CoinbaseCDP) [non-interactive]')
      .option('--api-key-secret <secret>', 'CDP API Key Secret (CoinbaseCDP) [non-interactive]')
      .option('--wallet-secret <secret>', 'CDP Wallet Secret (CoinbaseCDP) [non-interactive]')
      .option('--app-id <id>', 'Privy App ID (StripePrivy) [non-interactive]')
      .option('--app-secret <secret>', 'Privy App Secret (StripePrivy) [non-interactive]')
      .option('--authorization-private-key <key>', 'ECDSA P-256 private key (StripePrivy) [non-interactive]')
      .option('--authorization-id <id>', 'Authorization key identifier (StripePrivy) [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          manager?: string;
          name?: string;
          provider?: string;
          apiKeyId?: string;
          apiKeySecret?: string;
          walletSecret?: string;
          appId?: string;
          appSecret?: string;
          authorizationPrivateKey?: string;
          authorizationId?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            const hasAnyOption =
              cliOptions.manager ??
              cliOptions.name ??
              cliOptions.provider ??
              cliOptions.apiKeyId ??
              cliOptions.apiKeySecret ??
              cliOptions.walletSecret ??
              cliOptions.appId ??
              cliOptions.appSecret ??
              cliOptions.authorizationPrivateKey ??
              cliOptions.authorizationId ??
              cliOptions.json;

            if (hasAnyOption) {
              if (!cliOptions.provider) {
                const error = '--provider is required. Valid: CoinbaseCDP, StripePrivy';
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }
              let provider: PaymentProvider;
              try {
                provider = PaymentProviderSchema.parse(cliOptions.provider);
              } catch {
                const error = `Invalid provider "${cliOptions.provider}". Valid: CoinbaseCDP, StripePrivy`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              const missing: string[] = [];
              if (!cliOptions.manager) missing.push('--manager');
              if (!cliOptions.name) missing.push('--name');

              if (provider === 'StripePrivy') {
                if (!cliOptions.appId?.trim()) missing.push('--app-id');
                if (!cliOptions.appSecret?.trim()) missing.push('--app-secret');
                if (!cliOptions.authorizationPrivateKey?.trim()) missing.push('--authorization-private-key');
                if (!cliOptions.authorizationId?.trim()) missing.push('--authorization-id');
              } else {
                if (!cliOptions.apiKeyId?.trim()) missing.push('--api-key-id');
                if (!cliOptions.apiKeySecret?.trim()) missing.push('--api-key-secret');
                if (!cliOptions.walletSecret?.trim()) missing.push('--wallet-secret');
              }

              if (missing.length > 0) {
                const error = `Missing required options for ${provider}: ${missing.join(', ')}`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              const nameResult = PaymentConnectorNameSchema.safeParse(cliOptions.name);
              if (!nameResult.success) {
                const error = `Invalid connector name: ${nameResult.error.issues[0]?.message}`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              // Validate StripePrivy authorizationPrivateKey format (base64-encoded EC P-256 key)
              if (provider === 'StripePrivy') {
                // AWS docs ship the key with a `wallet-auth:` prefix — strip it transparently.
                let trimmedKey = cliOptions.authorizationPrivateKey!.trim();
                if (trimmedKey.startsWith('wallet-auth:')) {
                  trimmedKey = trimmedKey.slice('wallet-auth:'.length);
                  cliOptions.authorizationPrivateKey = trimmedKey;
                }
                const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/;
                if (!BASE64_REGEX.test(trimmedKey)) {
                  const error = 'authorizationPrivateKey must be base64-encoded';
                  if (cliOptions.json) {
                    console.log(JSON.stringify({ success: false, error }));
                  } else {
                    console.error(error);
                  }
                  process.exit(1);
                }
                const decoded = Buffer.from(trimmedKey, 'base64');
                if (decoded.length < 100 || decoded.length > 200) {
                  const error =
                    'authorizationPrivateKey must be a base64-encoded EC P-256 private key (unexpected length)';
                  if (cliOptions.json) {
                    console.log(JSON.stringify({ success: false, error }));
                  } else {
                    console.error(error);
                  }
                  process.exit(1);
                }
              }

              let result: Awaited<ReturnType<typeof this.add>>;
              if (provider === 'StripePrivy') {
                result = await this.add({
                  manager: cliOptions.manager!,
                  name: cliOptions.name!,
                  provider,
                  appId: cliOptions.appId!.trim(),
                  appSecret: cliOptions.appSecret!.trim(),
                  authorizationPrivateKey: cliOptions.authorizationPrivateKey!.trim(),
                  authorizationId: cliOptions.authorizationId!.trim(),
                });
              } else {
                result = await this.add({
                  manager: cliOptions.manager!,
                  name: cliOptions.name!,
                  provider,
                  apiKeyId: cliOptions.apiKeyId!.trim(),
                  apiKeySecret: cliOptions.apiKeySecret!.trim(),
                  walletSecret: cliOptions.walletSecret!.trim(),
                });
              }

              if (cliOptions.json) {
                console.log(
                  JSON.stringify(
                    result.success
                      ? result
                      : {
                          success: false,
                          error: result.error instanceof Error ? result.error.message : String(result.error),
                        }
                  )
                );
              } else if (result.success) {
                console.log(`Added payment connector '${result.connectorName}' to manager '${result.managerName}'`);
                console.log(`Credential '${result.credentialName}' created and secrets stored in .env.local`);
                console.log(`Run \`agentcore deploy\` to create payment infrastructure on AWS.`);
              } else {
                console.error(result.error.message);
              }
              process.exit(result.success ? 0 : 1);
            } else {
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'payment-connector',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            }
          } catch (error) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
            } else {
              console.error(`Error: ${getErrorMessage(error)}`);
            }
            process.exit(1);
          }
        }
      );

    removeCmd
      .command('payment-connector')
      .description('Remove a payment connector from a payment manager')
      .option('--name <name>', 'Name of connector to remove [non-interactive]')
      .option('--manager <manager>', 'Payment manager name [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; manager?: string; yes?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: false, error: '--name is required' }));
              } else {
                console.error('--name is required');
              }
              process.exit(1);
            }

            // Build composite key when --manager is provided
            const removeKey = cliOptions.manager ? `${cliOptions.manager}/${cliOptions.name}` : cliOptions.name;
            const result = await this.remove(removeKey);

            if (cliOptions.json) {
              console.log(
                JSON.stringify({
                  success: result.success,
                  resourceType: this.kind,
                  resourceName: cliOptions.name,
                  message: result.success ? `Removed payment connector '${cliOptions.name}'` : undefined,
                  note: result.success ? SOURCE_CODE_NOTE : undefined,
                  error: !result.success ? result.error.message : undefined,
                })
              );
            } else if (result.success) {
              console.log(`Removed payment connector '${cliOptions.name}'`);
            } else {
              console.error(result.error.message);
            }
            process.exit(result.success ? 0 : 1);
          } else {
            requireTTY();
            const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/remove'),
            ]);
            const { clear, unmount } = render(
              React.createElement(RemoveFlow, {
                isInteractive: false,
                force: cliOptions.yes,
                initialResourceType: this.kind,
                initialResourceName: cliOptions.name,
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(`Error: ${getErrorMessage(error)}`);
          }
          process.exit(1);
        }
      });
  }

  addScreen(): AddScreenComponent {
    return null;
  }
}
