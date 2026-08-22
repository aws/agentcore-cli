import { runCliCommand } from '../../telemetry/cli-command-run';
import { executeDeleteCapacityProviderSession, resolveDeleteTarget } from './action';
import { CAPACITY_PROVIDER_SESSION_ID_MAX_LENGTH, isValidCapacityProviderSessionId } from './constants';
import type { Command } from '@commander-js/extra-typings';
import * as readline from 'node:readline/promises';

/**
 * Interactive destructive-confirmation prompt. Returns false on a bare Enter or a non-TTY stdin so
 * the delete never proceeds implicitly — callers must pass --yes for non-interactive use.
 */
async function confirmDestructiveDelete(displayName: string, sessionId: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(
    `\n⚠  Deleting session "${sessionId}" on capacity provider "${displayName}" will deprovision its ` +
      `EC2 instance and permanently delete any persistent EBS volumes on the session. This cannot be undone.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Continue? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Registers `agentcore capacity-provider delete-session` — a data-plane command that tears down a
 * single live capacity provider session (deprovisioning its EC2 instance + persistent EBS volumes).
 */
export function registerCapacityProvider(program: Command) {
  const capacityProvider = program.command('capacity-provider').description('Manage capacity provider sessions');

  capacityProvider
    .command('delete-session')
    .description(
      'Delete (deprovision) a live capacity provider session. Terminates its EC2 instance and deletes any persistent EBS volumes.'
    )
    .requiredOption(
      '--capacity-provider <name-id-or-arn>',
      'Capacity provider: an in-project name, a capacity provider id, or an ARN. The data-plane API is keyed on the id; a name is resolved to its id via deployed state.'
    )
    .requiredOption('--session-id <id>', 'Session id to delete')
    .option('--region <region>', 'AWS region (auto-detected from the ARN / project otherwise)')
    .option('--yes', 'Skip the destructive confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(cliOptions => {
      return runCliCommand('capacity-provider.delete-session', !!cliOptions.json, async () => {
        if (!isValidCapacityProviderSessionId(cliOptions.sessionId)) {
          throw new Error(
            `Invalid --session-id "${cliOptions.sessionId}". Must be 1-${CAPACITY_PROVIDER_SESSION_ID_MAX_LENGTH} characters, start with an alphanumeric, and contain only letters, digits, hyphens, and underscores.`
          );
        }

        const target = await resolveDeleteTarget({
          capacityProvider: cliOptions.capacityProvider,
          sessionId: cliOptions.sessionId,
          region: cliOptions.region,
        });

        if (!cliOptions.yes) {
          const confirmed = await confirmDestructiveDelete(target.displayName, cliOptions.sessionId);
          if (!confirmed) {
            throw new Error(
              process.stdin.isTTY
                ? 'Aborted — session was not deleted.'
                : 'Refusing to delete a capacity provider session without confirmation. Re-run with --yes to skip the prompt.'
            );
          }
        }

        const result = await executeDeleteCapacityProviderSession(target, cliOptions.sessionId);

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`Deprovisioning session "${result.sessionId ?? cliOptions.sessionId}" (asynchronous)…`);
          console.log(`  Status:            ${result.status ?? 'Deprovisioning'}`);
          console.log(
            `  Capacity provider: ${result.capacityProviderArn ?? target.capacityProviderArn ?? target.displayName}`
          );
        }

        return { target_by_arn: target.targetByArn };
      });
    });
}
