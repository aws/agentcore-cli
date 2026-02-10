import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { DestroyScreen } from '../../tui/screens/destroy/DestroyScreen';
import { handleDestroy } from './actions';
import type { DestroyOptions } from './types';
import { validateDestroyOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function handleDestroyTUI(): void {
  requireProject();

  const { unmount } = render(
    <DestroyScreen
      isInteractive={false}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />
  );
}

async function handleDestroyCLI(options: DestroyOptions): Promise<void> {
  const validation = validateDestroyOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  const result = await handleDestroy({
    target: options.target!,
    autoConfirm: options.yes,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`Destroyed '${result.targetName}' (stack: ${result.stackName})`);
  } else {
    console.error(result.error);
  }

  process.exit(result.success ? 0 : 1);
}

export const registerDestroy = (program: Command) => {
  program
    .command('destroy')
    .alias('x')
    .description(COMMAND_DESCRIPTIONS.destroy)
    .option('--target <target>', 'Deployment target name to destroy [non-interactive]')
    .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async (cliOptions: { target?: string; yes?: boolean; json?: boolean }) => {
      try {
        requireProject();
        // Any flag triggers non-interactive CLI mode
        if (cliOptions.target || cliOptions.yes || cliOptions.json) {
          const options = {
            ...cliOptions,
            target: cliOptions.target ?? 'default',
          };
          await handleDestroyCLI(options as DestroyOptions);
        } else {
          handleDestroyTUI();
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
};
