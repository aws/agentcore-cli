import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { DeployScreen } from '../../tui/screens/deploy/DeployScreen';
import { handleDeploy } from './actions';
import type { DeployOptions } from './types';
import { validateDeployOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function handleDeployTUI(options: { autoConfirm?: boolean } = {}): void {
  requireProject();

  const { unmount } = render(
    <DeployScreen
      isInteractive={false}
      autoConfirm={options.autoConfirm}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
      onShellCommand={command => {
        unmount();
        if (command) {
          console.log(`\nRun: ${command}\n`);
        } else {
          console.log('\nSet your AWS credentials and re-run `agentcore deploy`\n');
        }
        process.exit(0);
      }}
    />
  );
}

async function handleDeployCLI(options: DeployOptions): Promise<void> {
  const validation = validateDeployOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  let spinner: NodeJS.Timeout | undefined;

  // Progress callback for --progress mode
  const onProgress = options.progress
    ? (step: string, status: 'start' | 'success' | 'error') => {
        if (spinner) {
          clearInterval(spinner);
          process.stdout.write('\r\x1b[K'); // Clear line
        }

        if (status === 'start') {
          let i = 0;
          process.stdout.write(`${SPINNER_FRAMES[0]} ${step}...`);
          spinner = setInterval(() => {
            i = (i + 1) % SPINNER_FRAMES.length;
            process.stdout.write(`\r${SPINNER_FRAMES[i]} ${step}...`);
          }, 80);
        } else if (status === 'success') {
          console.log(`✓ ${step}`);
        } else {
          console.log(`✗ ${step}`);
        }
      }
    : undefined;

  const onResourceEvent = options.verbose
    ? (message: string) => {
        console.log(message);
      }
    : undefined;

  const result = await handleDeploy({
    target: options.target!,
    autoConfirm: options.yes,
    verbose: options.verbose,
    onProgress,
    onResourceEvent,
  });

  if (spinner) {
    clearInterval(spinner);
    process.stdout.write('\r\x1b[K');
  }

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    console.log(`\n✓ Deployed to '${result.targetName}' (stack: ${result.stackName})`);

    // Show stack outputs in non-JSON mode
    if (result.outputs && Object.keys(result.outputs).length > 0) {
      console.log('\nOutputs:');
      for (const [key, value] of Object.entries(result.outputs)) {
        console.log(`  ${key}: ${value}`);
      }
    }

    if (result.logPath) {
      console.log(`\nLog: ${result.logPath}`);
    }
    if (result.nextSteps && result.nextSteps.length > 0) {
      console.log(`Next: ${result.nextSteps.join(' | ')}`);
    }
  } else {
    console.error(result.error);
    if (result.logPath) {
      console.error(`Log: ${result.logPath}`);
    }
  }

  process.exit(result.success ? 0 : 1);
}

export const registerDeploy = (program: Command) => {
  program
    .command('deploy')
    .alias('p')
    .description(COMMAND_DESCRIPTIONS.deploy)
    .option('--target <target>', 'Deployment target name')
    .option('-y, --yes', 'Auto-confirm prompts (e.g., bootstrap)')
    .option('--progress', 'Show deployment progress in real-time')
    .option('-v, --verbose', 'Show resource-level deployment events')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { target?: string; yes?: boolean; progress?: boolean; json?: boolean }) => {
      try {
        requireProject();
        if (cliOptions.json || cliOptions.target || cliOptions.progress) {
          // Default to "default" target in CLI mode
          const options = { ...cliOptions, target: cliOptions.target ?? 'default' };
          await handleDeployCLI(options as DeployOptions);
        } else {
          handleDeployTUI({ autoConfirm: cliOptions.yes });
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
