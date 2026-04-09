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
