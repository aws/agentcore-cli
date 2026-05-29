import { COMMAND_DESCRIPTIONS } from '../../tui/copy.js';
import { handleTelemetryDisable, handleTelemetryEnable, handleTelemetryStatus } from './actions.js';
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
Audit Mode:
  Enable audit mode to also log every telemetry event locally.
  Run: agentcore config telemetry.audit true
  Events are written to ~/.agentcore/telemetry/.
  Telemetry is sent to: [ENDPOINT]

  For more information on what exactly is captured, see the schemas, which
  include all attributes and metrics captured:
    https://github.com/aws/agentcore-cli/tree/main/src/cli/telemetry/schemas
`
  );

  telemetry
    .command('disable')
    .description('Disable anonymous usage analytics')
    .action(async () => {
      await handleTelemetryDisable();
    });

  telemetry
    .command('enable')
    .description('Enable anonymous usage analytics')
    .action(async () => {
      await handleTelemetryEnable();
    });

  telemetry
    .command('status')
    .description('Show current telemetry preference and source')
    .action(async () => {
      await handleTelemetryStatus();
    });
}
