import { ConfigIO, removeEnvVars, serializeResult, toError } from '../../../lib';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import {
  computePaymentCredentialEnvVarNames,
  computeStripePrivyCredentialEnvVarNames,
} from '../../primitives/credential-utils';
import { runCliCommand } from '../../telemetry/cli-command-run.js';
import { renderTUI } from '../../tui';
import { requireProject, requireTTY } from '../../tui/guards';
import type { RemoveAllOptions, RemoveResult } from './types';
import { validateRemoveAllOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

async function handleRemoveAll(options: RemoveAllOptions): Promise<RemoveResult> {
  try {
    const configIO = new ConfigIO();

    if (options.dryRun) {
      const current = await configIO.readProjectSpec();
      const items: string[] = [];
      for (const r of current.runtimes ?? []) items.push(`runtime: ${r.name}`);
      for (const m of current.memories ?? []) items.push(`memory: ${m.name}`);
      for (const c of current.credentials ?? []) items.push(`credential: ${c.name}`);
      for (const p of current.payments ?? []) items.push(`payment-manager: ${p.name}`);
      for (const e of current.evaluators ?? []) items.push(`evaluator: ${e.name}`);
      for (const g of current.agentCoreGateways ?? []) items.push(`gateway: ${g.name}`);
      for (const pe of current.policyEngines ?? []) items.push(`policy-engine: ${pe.name}`);
      return {
        success: true,
        message: items.length > 0 ? `Would remove: ${items.join(', ')}` : 'Nothing to remove',
      };
    }

    // Get current project name to preserve it
    let projectName = 'Project';
    try {
      const current = await configIO.readProjectSpec();
      projectName = current.name;
    } catch {
      // Use default if can't read
    }

    // Clean up payment credential env vars from .env.local before resetting
    try {
      const current = await configIO.readProjectSpec();
      for (const payment of current.payments ?? []) {
        for (const connector of payment.connectors) {
          const provider = connector.provider ?? 'CoinbaseCDP';
          if (provider === 'StripePrivy') {
            const vars = computeStripePrivyCredentialEnvVarNames(connector.credentialName);
            await removeEnvVars([vars.appId, vars.appSecret, vars.authorizationPrivateKey, vars.authorizationId]);
          } else {
            const vars = computePaymentCredentialEnvVarNames(connector.credentialName);
            await removeEnvVars([vars.apiKeyId, vars.apiKeySecret, vars.walletSecret]);
          }
        }
      }
    } catch {
      // Best-effort: continue with reset even if env cleanup fails
    }

    // Reset agentcore.json (keep project name + tags, clear all resources)
    await configIO.writeProjectSpec({
      $schema: 'https://schema.agentcore.aws.dev/v1/agentcore.json',
      name: projectName,
      version: 1,
      managedBy: 'CDK' as const,
      tags: {
        'agentcore:created-by': 'agentcore-cli',
        'agentcore:project-name': projectName,
      },
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
      harnesses: [],
      datasets: [],
      payments: [],
    });

    // Preserve aws-targets.json and deployed-state.json so that
    // a subsequent `agentcore deploy` can tear down existing stacks.

    return {
      success: true,
      message: 'All schemas reset to empty state',
      note: 'Your source code has not been modified. Run `agentcore deploy` to apply changes to AWS.',
    };
  } catch (err) {
    return { success: false, error: toError(err) };
  }
}

async function handleRemoveAllCLI(options: RemoveAllOptions): Promise<void> {
  validateRemoveAllOptions(options);
  await runCliCommand('remove.all', !!options.json, async () => {
    const result = await handleRemoveAll(options);
    if (!result.success) throw result.error;
    if (options.json) {
      console.log(JSON.stringify(serializeResult(result)));
    } else {
      console.log(result.message ?? 'All schemas reset to empty state');
      if (result.note) console.log(result.note);
    }
    return {};
  });
}

export const registerRemove = (program: Command): Command => {
  const removeCommand = program.command('remove').description(COMMAND_DESCRIPTIONS.remove);

  // 'remove all' is a special command, not a primitive
  removeCommand
    .command('all')
    .description('Reset all agentcore schemas to empty state')
    .option('-y, --yes', 'Skip confirmation prompts [non-interactive]')
    .option('--dry-run', 'Show what would be reset without actually resetting [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async (cliOptions: { yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      try {
        // Any flag triggers non-interactive CLI mode
        if (cliOptions.yes || cliOptions.dryRun || cliOptions.json) {
          await handleRemoveAllCLI({
            force: cliOptions.yes,
            dryRun: cliOptions.dryRun,
            json: cliOptions.json,
          });
        } else {
          requireTTY();
          await renderTUI({
            initialRoute: { name: 'remove', screen: 'all' },
            enterAltScreen: false,
            actionOnBack: 'exit',
            isInteractive: false,
          });
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });

  // Resource subcommands (agent, memory, credential, gateway, mcp-tool) are registered
  // via primitive.registerCommands() in cli.ts

  // Catch-all for TUI fallback when no subcommand is specified.
  // Commander matches named subcommands first, so this is safe even though
  // primitive subcommands are registered after this point.
  removeCommand
    .argument('[subcommand]')
    .action(async (subcommand: string | undefined, _options, cmd) => {
      if (subcommand) {
        console.error(`error: '${subcommand}' is not a valid subcommand.`);
        cmd.outputHelp();
        process.exit(1);
      }

      requireProject();
      requireTTY();

      await renderTUI({
        initialRoute: { name: 'remove' },
        enterAltScreen: false,
        actionOnBack: 'exit',
        isInteractive: false,
      });
    })
    .showHelpAfterError()
    .showSuggestionAfterError();

  return removeCommand;
};
