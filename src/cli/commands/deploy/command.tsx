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

function handleDeployTUI(options: { autoConfirm?: boolean; diffMode?: boolean } = {}): void {
  requireProject();

  const { unmount } = render(
    <DeployScreen
      isInteractive={false}
      autoConfirm={options.autoConfirm}
      diffMode={options.diffMode}
      onExit={() => {
        unmount();
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
    verbose: options.verbose ?? options.diff,
    plan: options.plan,
    diff: options.diff,
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
    if (options.diff) {
      console.log(`\n✓ Diff complete for '${result.targetName}' (stack: ${result.stackName})`);
    } else if (options.plan) {
      console.log(`\n✓ Dry run complete for '${result.targetName}' (stack: ${result.stackName})`);
      console.log('\nRun `agentcore deploy` to deploy.');
    } else {
      console.log(`\n✓ Deployed to '${result.targetName}' (stack: ${result.stackName})`);

      // Show stack outputs in non-JSON mode
      if (result.outputs && Object.keys(result.outputs).length > 0) {
        console.log('\nOutputs:');
        for (const [key, value] of Object.entries(result.outputs)) {
          console.log(`  ${key}: ${value}`);
        }
      }

      if (result.notes && result.notes.length > 0) {
        for (const note of result.notes) {
          console.log(`\nNote: ${note}`);
        }
      }

      if (result.nextSteps && result.nextSteps.length > 0) {
        console.log(`Next: ${result.nextSteps.join(' | ')}`);
      }
    }

    if (result.logPath) {
      console.log(`\nLog: ${result.logPath}`);
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
    .alias('dp')
    .description(COMMAND_DESCRIPTIONS.deploy)
    .option('--target <target>', 'Deployment target name (default: "default") [non-interactive]')
    .option('-y, --yes', 'Auto-confirm prompts, read credentials from env [non-interactive]')
    .option('-v, --verbose', 'Show resource-level deployment events [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .option('--dry-run', 'Preview deployment without deploying [non-interactive]')
    .option('--diff', 'Show CDK diff without deploying [non-interactive]')
    .action(
      async (cliOptions: {
        target?: string;
        yes?: boolean;
        verbose?: boolean;
        json?: boolean;
        dryRun?: boolean;
        diff?: boolean;
      }) => {
        try {
          requireProject();
          if (cliOptions.json || cliOptions.target || cliOptions.dryRun || cliOptions.yes || cliOptions.verbose) {
            // CLI mode - any flag triggers non-interactive mode
            const options = {
              ...cliOptions,
              plan: cliOptions.dryRun,
              target: cliOptions.target ?? 'default',
              progress: !cliOptions.json,
            };
            await handleDeployCLI(options as DeployOptions);
          } else if (cliOptions.diff) {
            // Diff-only: use TUI with diff mode
            handleDeployTUI({ diffMode: true });
          } else {
            handleDeployTUI();
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          }
          process.exit(1);
        }
      }
    );
};
