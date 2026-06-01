import { COMMAND_DESCRIPTIONS } from '../../tui/copy.js';
import { handleTelemetryStatus } from './actions.js';
import type { Command } from '@commander-js/extra-typings';

export function registerTelemetry(program: Command) {
  const telemetry = program
    .command('telemetry')
    .description(COMMAND_DESCRIPTIONS.telemetry)
    .action(() => {
      telemetry.outputHelp();
    });

  telemetry.addHelpText(
    'after',
    `
Manage Telemetry Preferences:
  Opt in:   agentcore config telemetry.enabled true
  Opt out:  agentcore config telemetry.enabled false
  Status:   agentcore telemetry status

Audit Mode:
  Enable audit mode to also log every telemetry event locally.
  Run: agentcore config telemetry.audit true
  Events are written to ~/.agentcore/telemetry/.

  For more information, see https://github.com/aws/agentcore-cli/blob/main/docs/telemetry.md`
  );

  telemetry
    .command('status')
    .description('Show current telemetry preference and source')
    .action(async () => {
      await handleTelemetryStatus();
    });
}
