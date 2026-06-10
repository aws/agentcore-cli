import { findConfigRoot, removeEnvVars, serializeResult, toError } from '../../lib';
import type { AgentCoreProjectSpec, PaymentAuthorizerType } from '../../schema';
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentAuthorizerTypeSchema,
  PaymentManagerNameSchema,
  PaymentManagerSchema,
} from '../../schema';
import type { RemoveResult } from '../commands/remove/types';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { getTemplatePath } from '../templates/templateRoot';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import { computePaymentCredentialEnvVarNames, computeStripePrivyCredentialEnvVarNames } from './credential-utils';
import { isPaymentEligibleRuntime } from './payment-eligible';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Find a safe character offset for inserting a top-level Python import.
 *
 * Python requires `from __future__ import ...` to appear before any other
 * imports. A module-level docstring (if present) must appear before any
 * import. This helper returns the offset just AFTER:
 *   - any leading shebang / encoding cookie,
 *   - an optional module docstring (`""" ... """` or `''' ... '''`),
 *   - all `from __future__ import ...` lines (single- or multi-line).
 *
 * Inserting at this offset is safe regardless of how the user has formatted
 * the rest of their imports (parenthesised multi-line, conditional imports,
 * etc.) — we never splice into the middle of an existing import statement.
 */
export function computeImportInsertionPoint(source: string): number {
  let pos = 0;
  const len = source.length;

  // Skip BOM, shebang, leading blank/comment-only lines, and a module docstring.
  // We walk line-by-line; any non-blank, non-shebang, non-comment, non-docstring
  // line ends the prelude.
  while (pos < len) {
    // Skip blank lines.
    if (source[pos] === '\n') {
      pos++;
      continue;
    }
    // Read one line.
    const lineEnd = source.indexOf('\n', pos);
    const lineEndPos = lineEnd === -1 ? len : lineEnd;
    const line = source.slice(pos, lineEndPos);
    const trimmed = line.trim();

    // Shebang or encoding cookie or comment — skip the line.
    if (trimmed.startsWith('#')) {
      pos = lineEndPos + 1;
      continue;
    }

    // Module docstring? Match a triple-quoted string at the start of the line.
    if (/^("""|''')/.test(trimmed)) {
      const quote = trimmed.startsWith('"""') ? '"""' : "'''";
      // Single-line docstring.
      const restOfLine = trimmed.slice(3);
      if (restOfLine.endsWith(quote) && restOfLine.length >= 3) {
        pos = lineEndPos + 1;
        continue;
      }
      // Multi-line docstring — find the closing quote.
      const closeIdx = source.indexOf(quote, pos + 3);
      if (closeIdx === -1) break;
      const afterClose = source.indexOf('\n', closeIdx + 3);
      pos = afterClose === -1 ? len : afterClose + 1;
      continue;
    }

    // `from __future__ import ...` — skip past the entire (possibly multi-line) statement.
    if (/^from __future__ import\b/.test(trimmed)) {
      // Multi-line parenthesised form: keep advancing until parens balance.
      const openParen = line.indexOf('(');
      if (openParen !== -1 && !line.includes(')', openParen)) {
        const closeParen = source.indexOf(')', pos);
        if (closeParen === -1) break;
        const afterClose = source.indexOf('\n', closeParen);
        pos = afterClose === -1 ? len : afterClose + 1;
      } else {
        pos = lineEndPos + 1;
      }
      continue;
    }

    // Anything else — we're past the prelude. Insert here.
    break;
  }

  return pos;
}

/**
 * Options for adding a payment manager resource.
 */
export interface AddPaymentManagerOptions {
  name: string;
  authorizerType: PaymentAuthorizerType;
  discoveryUrl?: string;
  allowedClients?: string[];
  allowedAudience?: string[];
  allowedScopes?: string[];
  description?: string;
  autoPayment?: boolean;
  defaultSpendLimit?: string;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
}

/**
 * PaymentManagerPrimitive handles payment manager add/remove operations.
 * Manages the top-level payment manager entry in agentcore.json.
 * Connectors (child resources) are managed by PaymentConnectorPrimitive.
 */
export class PaymentManagerPrimitive extends BasePrimitive<AddPaymentManagerOptions, RemovableResource> {
  readonly kind = 'payment-manager' as const;
  readonly label = 'Payment Manager';
  readonly primitiveSchema = PaymentManagerSchema;

  async add(
    options: AddPaymentManagerOptions
  ): Promise<AddResult<{ managerName: string; skippedRuntimes?: string[] }>> {
    try {
      const project = await this.readProjectSpec();
      // payments is optional in the schema (absent on projects with no payment
      // managers); normalize to an array so the mutating logic below is safe.
      project.payments ??= [];

      this.checkDuplicate(project.payments, options.name, 'Payment manager');

      if (options.authorizerType === 'CUSTOM_JWT' && !options.discoveryUrl) {
        return { success: false, error: new Error('--discovery-url is required when --authorizer-type is CUSTOM_JWT') };
      }

      const authorizerConfiguration =
        options.authorizerType === 'CUSTOM_JWT'
          ? {
              customJWTAuthorizer: {
                discoveryUrl: options.discoveryUrl!,
                ...(options.allowedClients && { allowedClients: options.allowedClients }),
                ...(options.allowedAudience && { allowedAudience: options.allowedAudience }),
                ...(options.allowedScopes && { allowedScopes: options.allowedScopes }),
              },
            }
          : undefined;

      project.payments.push({
        name: options.name,
        authorizerType: options.authorizerType,
        ...(authorizerConfiguration && { authorizerConfiguration }),
        connectors: [],
        ...(options.description && { description: options.description }),
        autoPayment: options.autoPayment ?? DEFAULT_AUTO_PAYMENT,
        defaultSpendLimit: options.defaultSpendLimit ?? DEFAULT_SPEND_LIMIT,
        ...(options.paymentToolAllowlist?.length && { paymentToolAllowlist: options.paymentToolAllowlist }),
        ...(options.networkPreferences?.length && { networkPreferences: options.networkPreferences }),
      });

      await this.writeProjectSpec(project);

      // Wire payment capability into all agents.
      // Payments today only ships a runtime shim for Python Strands HTTP agents.
      // Skip everything else (TypeScript runtimes, MCP/A2A/AGUI protocols,
      // non-Strands Python frameworks) — those would either no-op or have
      // their main.py corrupted by the Strands-shaped template. The runtime
      // name is collected so the CLI can warn the user that payments must be
      // wired manually for those runtimes.
      const configRoot = findConfigRoot();
      const skippedRuntimes: string[] = [];
      if (configRoot) {
        for (const runtime of project.runtimes) {
          if (!isPaymentEligibleRuntime(runtime)) {
            skippedRuntimes.push(runtime.name);
            continue;
          }
          const wired = this.wirePaymentCapability(configRoot, runtime.codeLocation);
          if (!wired) {
            skippedRuntimes.push(runtime.name);
          }
        }
      }

      return { success: true, managerName: options.name, skippedRuntimes };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(name: string): Promise<RemoveResult> {
    try {
      const project = await this.readProjectSpec();
      project.payments ??= [];

      const index = project.payments.findIndex(p => p.name === name);
      if (index === -1) {
        return { success: false, error: new Error(`Payment manager "${name}" not found.`) };
      }

      const manager = project.payments[index]!;

      // Collect connector info before removal for cleanup
      const connectorInfo = manager.connectors.map(c => ({
        credentialName: c.credentialName,
        provider: c.provider,
      }));

      // Remove the manager (which removes all its nested connectors)
      project.payments.splice(index, 1);

      // Remove associated credentials that are no longer referenced by any connector
      for (const { credentialName } of connectorInfo) {
        const stillReferenced = project.payments.some(m => m.connectors.some(c => c.credentialName === credentialName));
        if (!stillReferenced) {
          const credIndex = project.credentials.findIndex(c => c.name === credentialName);
          if (credIndex !== -1) {
            project.credentials.splice(credIndex, 1);
          }
        }
      }

      await this.writeProjectSpec(project);

      // Clean up .env.local secrets for removed credentials (provider-specific)
      for (const { credentialName, provider } of connectorInfo) {
        const stillReferenced = project.payments.some(m => m.connectors.some(c => c.credentialName === credentialName));
        if (!stillReferenced) {
          try {
            if (provider === 'StripePrivy') {
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
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    project.payments ??= [];

    const manager = project.payments.find(p => p.name === name);
    if (!manager) {
      throw new Error(`Payment manager "${name}" not found.`);
    }

    const summary: string[] = [`Removing payment manager: ${name}`];
    if (manager.connectors.length > 0) {
      summary.push(`Note: ${manager.connectors.length} connector(s) within this manager will also be removed`);
      for (const conn of manager.connectors) {
        summary.push(`  - Connector: ${conn.name} (credential: ${conn.credentialName})`);
      }
    }

    const credentialNames = manager.connectors.map(c => c.credentialName);
    for (const credName of credentialNames) {
      const otherReferences = project.payments.some(
        m => m.name !== name && m.connectors.some(c => c.credentialName === credName)
      );
      if (!otherReferences) {
        summary.push(`Associated credential "${credName}" will also be removed`);
      } else {
        summary.push(`Credential "${credName}" is shared by other managers and will be kept`);
      }
    }

    const schemaChanges: SchemaChange[] = [];
    const afterSpec: AgentCoreProjectSpec = {
      ...project,
      payments: project.payments.filter(p => p.name !== name),
    };
    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.payments ?? []).map(p => ({ name: p.name }));
    } catch {
      return [];
    }
  }

  async getExistingManagers(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.payments ?? []).map(p => p.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('payment-manager')
      .description('Add a payment manager to the project')
      .option('--name <name>', 'Payment manager name [non-interactive]')
      .option('--authorizer-type <type>', 'Authorizer type: AWS_IAM or CUSTOM_JWT (default: AWS_IAM) [non-interactive]')
      .option('--discovery-url <url>', 'OIDC discovery URL (required for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-audience <audience>', 'Comma-separated allowed audiences (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT) [non-interactive]')
      .option('--auto-payment [value]', 'Enable auto payment: true or false (default: true) [non-interactive]')
      .option(
        '--default-spend-limit <amount>',
        'Spend cap (USD) for sessions created by `invoke --auto-session` ONLY; not a deployed-agent budget (default: 10.00) [non-interactive]'
      )
      .option('--tool-allowlist <tools>', 'Comma-separated tool names eligible for payment [non-interactive]')
      .option(
        '--network-preferences <networks>',
        'Comma-separated network identifiers e.g. eip155:84532 [non-interactive]'
      )
      .option('--description <desc>', 'Payment manager description [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          authorizerType?: string;
          discoveryUrl?: string;
          allowedClients?: string;
          allowedAudience?: string;
          allowedScopes?: string;
          autoPayment?: string | boolean;
          defaultSpendLimit?: string;
          toolAllowlist?: string;
          networkPreferences?: string;
          description?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.name !== undefined || cliOptions.authorizerType || cliOptions.json) {
              if (!cliOptions.name) {
                const error = '--name is required';
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              const nameResult = PaymentManagerNameSchema.safeParse(cliOptions.name);
              if (!nameResult.success) {
                const error = `Invalid name: ${nameResult.error.issues[0]?.message}`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              let authorizerType: PaymentAuthorizerType;
              try {
                authorizerType = PaymentAuthorizerTypeSchema.parse(cliOptions.authorizerType ?? 'AWS_IAM');
              } catch {
                const error = `Invalid authorizer type "${cliOptions.authorizerType}". Valid: AWS_IAM, CUSTOM_JWT`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              if (cliOptions.defaultSpendLimit !== undefined) {
                const num = Number(cliOptions.defaultSpendLimit);
                if (Number.isNaN(num) || num < 0) {
                  const error = 'Invalid --default-spend-limit: must be a valid non-negative number (e.g., "10.00")';
                  if (cliOptions.json) {
                    console.log(JSON.stringify({ success: false, error }));
                  } else {
                    console.error(error);
                  }
                  process.exit(1);
                }
              }

              const parseList = (val?: string): string[] | undefined =>
                val
                  ? val
                      .split(',')
                      .map(s => s.trim())
                      .filter(Boolean)
                  : undefined;

              const result = await this.add({
                name: cliOptions.name,
                authorizerType,
                discoveryUrl: cliOptions.discoveryUrl,
                allowedClients: parseList(cliOptions.allowedClients),
                allowedAudience: parseList(cliOptions.allowedAudience),
                allowedScopes: parseList(cliOptions.allowedScopes),
                autoPayment:
                  cliOptions.autoPayment !== undefined
                    ? (() => {
                        const val = String(cliOptions.autoPayment).toLowerCase();
                        if (['true', 'false', 'yes', 'no', '1', '0', 'on', 'off'].includes(val)) {
                          return !['false', 'no', '0', 'off'].includes(val);
                        }
                        throw new Error(`Invalid --auto-payment value "${cliOptions.autoPayment}". Use true or false.`);
                      })()
                    : undefined,
                defaultSpendLimit: cliOptions.defaultSpendLimit,
                paymentToolAllowlist: parseList(cliOptions.toolAllowlist),
                networkPreferences: parseList(cliOptions.networkPreferences),
                description: cliOptions.description,
              });

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else if (result.success) {
                console.log(`Added payment manager '${result.managerName}'`);
                if (result.skippedRuntimes && result.skippedRuntimes.length > 0) {
                  console.warn(
                    `\nWarning: payment capability auto-wiring skipped for non-Strands runtime(s): ${result.skippedRuntimes.join(', ')}.`
                  );
                  console.warn(
                    `Payments are only auto-wired into Strands agents today. You will need to wire payment plugins manually for these runtimes.`
                  );
                } else {
                  console.log(`\nPayment capability code has been added to your agent(s).`);
                }
                console.log(
                  `Add a payment connector with \`agentcore add payment-connector --manager ${result.managerName}\``
                );
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
                  initialResource: 'payment-manager',
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
      .command('payment-manager')
      .description('Remove a payment manager from the project')
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean }) => {
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

            const result = await this.remove(cliOptions.name);
            if (cliOptions.json) {
              console.log(
                JSON.stringify({
                  success: result.success,
                  resourceType: this.kind,
                  resourceName: cliOptions.name,
                  message: result.success ? `Removed payment manager '${cliOptions.name}'` : undefined,
                  note: result.success ? SOURCE_CODE_NOTE : undefined,
                  error: !result.success ? result.error.message : undefined,
                })
              );
            } else if (result.success) {
              console.log(`Removed payment manager '${cliOptions.name}'`);
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

  /**
   * Wire payment capability template into an agent's code directory.
   * Copies payments.py and patches main.py to add the import line.
   *
   * Note: The per-invocation plugin setup (extracting user_id, instrument_id,
   * session_id from payload and creating the plugin inside the entrypoint) is
   * handled by the Handlebars template for new agents. For existing agents,
   * the user must manually update their entrypoint to use the factory pattern.
   */
  private wirePaymentCapability(configRoot: string, codeLocation: string): boolean {
    const projectRoot = dirname(configRoot);
    const agentDir = resolve(projectRoot, codeLocation);
    const capDir = join(agentDir, 'capabilities', 'payments');

    const mainPath = join(agentDir, 'main.py');
    if (!existsSync(mainPath)) return false;

    const main = readFileSync(mainPath, 'utf-8');

    // Only Strands templates have a payments capability shim today. The
    // shim's plugin pattern (Agent(plugins=[...])) is Strands-specific and
    // would not work for LangChain/LangGraph, GoogleADK, OpenAIAgents, etc.
    // Detect by import signature — the unrendered Handlebars template still
    // contains "from strands import" so this works pre- and post-render.
    const isStrandsAgent = /^from strands(\.|\s)/m.test(main) || main.includes('from strands import');
    if (!isStrandsAgent) {
      return false;
    }

    const templateDir = getTemplatePath('python', 'http', 'strands', 'capabilities', 'payments');
    if (!existsSync(templateDir)) return false;

    // Drop the capability files into the agent. Idempotent: skipped if
    // payments.py already exists (e.g. user is re-adding after remove).
    if (!existsSync(join(capDir, 'payments.py'))) {
      mkdirSync(capDir, { recursive: true });
      copyFileSync(join(templateDir, 'payments.py'), join(capDir, 'payments.py'));
    }
    const initPath = join(capDir, '__init__.py');
    if (!existsSync(initPath)) writeFileSync(initPath, '');
    const parentInit = join(agentDir, 'capabilities', '__init__.py');
    if (!existsSync(parentInit)) writeFileSync(parentInit, '');

    // Idempotency check: if main.py already imports the plugin factory, the
    // file has been patched in a prior add — leave it alone.
    if (main.includes('create_payments_plugin')) return true;

    const importLine = 'from capabilities.payments.payments import create_payments_plugin, PAYMENT_SYSTEM_PROMPT';

    let patched = main;

    // 1. Insert the payment import near the top of the file (after any module
    //    docstring and `from __future__` imports — Python requires those to
    //    come first). This avoids the brittle "find the last import" approach,
    //    which could splice the new import into the middle of a parenthesised
    //    multi-line import block and produce a SyntaxError.
    const insertPos = computeImportInsertionPoint(patched);
    patched = patched.slice(0, insertPos) + importLine + '\n' + patched.slice(insertPos);

    // 2. Replace "agent = get_or_create_agent()" with per-invocation agent + plugin creation
    //    The cached agent pattern can't work with per-invocation plugins because
    //    plugins are scoped to a request (different user_id/instrument_id/session_id).
    //    Allow optional trailing comments (e.g. `# type: ignore`).
    const agentCallPattern = /^([^\S\n]*)agent = get_or_create_agent\(\)[ \t]*(#[^\n]*)?$/m;
    const agentCallMatch = agentCallPattern.exec(patched);
    if (agentCallMatch) {
      const indent = agentCallMatch[1];
      // Preserve config-bundle wiring: if the file already imports
      // ConfigBundleHook, the existing Agent() must have used it; emit
      // hooks=[...] alongside the new plugins=[...] so we don't silently
      // regress that feature when the user adds payments.
      const usesConfigBundle = /\bConfigBundleHook\b/.test(patched);
      const replacement = [
        `${indent}# Payment plugin (per-invocation — different user/instrument/session per request)`,
        `${indent}user_id = payload.get("user_id") or getattr(context, "user_id", "default-user")`,
        `${indent}instrument_id = payload.get("payment_instrument_id")`,
        `${indent}session_id = payload.get("payment_session_id")`,
        `${indent}payments_plugin = create_payments_plugin(user_id, instrument_id, session_id)`,
        `${indent}plugins = [payments_plugin] if payments_plugin else []`,
        ``,
        `${indent}agent = Agent(`,
        `${indent}    model=load_model(),`,
        `${indent}    system_prompt=DEFAULT_SYSTEM_PROMPT + PAYMENT_SYSTEM_PROMPT,`,
        `${indent}    tools=tools,`,
        `${indent}    plugins=plugins,`,
        ...(usesConfigBundle ? [`${indent}    hooks=[ConfigBundleHook()],`] : []),
        `${indent})`,
      ].join('\n');
      patched =
        patched.slice(0, agentCallMatch.index) +
        replacement +
        patched.slice(agentCallMatch.index + agentCallMatch[0].length);

      // Remove the now-dead cached agent singleton (replaced by per-invocation Agent above).
      // Allow typed annotation form (`_agent: Agent | None = None`) and one-or-more blank
      // lines before `def get_or_create_agent():` (PEP-8 permits two blank lines).
      const singletonPattern =
        /^_agent(?:\s*:[^=\n]+)?\s*=\s*None\n\n+def get_or_create_agent\(\):[\s\S]+?return _agent\n/m;
      const before = patched;
      patched = patched.replace(singletonPattern, '');
      if (patched === before) {
        // Call site replaced but singleton not — abort with a clean error
        // rather than ship a corrupted main.py with a dead `_agent = None`
        // and an orphaned `get_or_create_agent` definition.
        throw new Error(
          `Could not safely auto-wire payments into ${mainPath}: the agent= call was replaced ` +
            `but the cached \`_agent\` / \`get_or_create_agent\` definition has an unrecognised shape. ` +
            `Edit main.py manually — see docs/payments.md for the expected pattern.`
        );
      }
    } else {
      const byoAgentPattern = /^(\s*)(agent = Agent\()/m;
      const byoMatch = byoAgentPattern.exec(patched);
      if (byoMatch) {
        const indent = byoMatch[1];
        const pluginSetup = [
          `${indent}# Payment plugin (per-invocation — different user/instrument/session per request)`,
          `${indent}user_id = payload.get("user_id") or getattr(context, "user_id", "default-user")`,
          `${indent}instrument_id = payload.get("payment_instrument_id")`,
          `${indent}session_id = payload.get("payment_session_id")`,
          `${indent}payments_plugin = create_payments_plugin(user_id, instrument_id, session_id)`,
          `${indent}plugins = [payments_plugin] if payments_plugin else []`,
          ``,
          `${indent}# TODO: Add plugins=plugins to your Agent() constructor below`,
          `${indent}${byoMatch[2]}`,
        ].join('\n');
        patched = patched.slice(0, byoMatch.index) + pluginSetup + patched.slice(byoMatch.index + byoMatch[0].length);
      }
    }

    writeFileSync(mainPath, patched);
    return true;
  }
}
