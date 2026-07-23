import { ConfigIO, serializeResult } from '../../../lib';
import { ANSI, COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { toDepSyncAttrs } from '../../operations/deploy';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { renderTUI } from '../../tui';
import { requireProject, requireTTY } from '../../tui/guards';
import { handleDeploy } from './actions';
import type { DeployOptions, DeployResult } from './types';
import { DEFAULT_DEPLOY_ATTRS, computeDeployAttrs } from './utils';
import { validateDeployOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function handleDeployTUI(options: { diffMode?: boolean } = {}): Promise<void> {
  requireProject();
  return renderTUI({
    initialRoute: { name: 'deploy', diffMode: options.diffMode },
    enterAltScreen: false,
    actionOnBack: 'exit',
    isInteractive: false,
  });
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

  // Compute attrs upfront from project spec (available before deploy)
  const mode = options.diff ? 'diff' : options.plan ? 'dry-run' : 'deploy';
  const attrs = await new ConfigIO()
    .readProjectSpec()
    .then(spec => computeDeployAttrs(spec, mode))
    .catch(() => ({ ...DEFAULT_DEPLOY_ATTRS, mode }) as const);

  const { deployResult } = await withCommandRunTelemetry('deploy', attrs, async recorder => {
    const result = await executeDeploy(options).catch(
      (e): DeployResult => ({ success: false, error: e instanceof Error ? e : new Error(getErrorMessage(e)) })
    );
    // Record dep_sync attrs whenever the sync ran — including on failed deploys, where the
    // failure result still carries the outcome (see handleDeploy's catch).
    if (result.dependencySyncResult) {
      recorder.set(toDepSyncAttrs(result.dependencySyncResult));
    }
    if (!result.success) {
      return { success: false as const, error: result.error, deployResult: result };
    }
    return { success: true as const, deployResult: result };
  });

  // ALL output happens here, after telemetry
  if (!deployResult.success) {
    if (options.json) {
      console.log(JSON.stringify(serializeResult(deployResult)));
    } else {
      // Dependency sync warnings still matter on a failed deploy: a downgraded-skew
      // warning may explain the failure itself, and printDeployResult only runs on success.
      // (The sync notice is NOT re-printed here — onNotice already printed it live during the
      // sync step for every non-JSON run.)
      for (const warning of deployResult.dependencySyncResult?.warnings ?? []) {
        console.error(`⚠ ${warning}`);
      }
      console.error(deployResult.error.message);
      if (deployResult.logPath) {
        console.error(`Log: ${deployResult.logPath}`);
      }
    }
    process.exit(1);
  }

  printDeployResult(deployResult, options);

  if (deployResult.postDeployWarnings && deployResult.postDeployWarnings.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

async function executeDeploy(options: DeployOptions): Promise<DeployResult> {
  let spinner: NodeJS.Timeout | undefined;

  // Progress callback for --progress mode
  const onProgress = options.progress
    ? (step: string, status: 'start' | 'success' | 'error' | 'warn') => {
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
        } else if (status === 'warn') {
          console.log(`${ANSI.yellow}⚠ ${step}${ANSI.reset}`);
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

  // One-shot user-facing notices (e.g. the managed-memory heads-up before the slow CFN apply).
  // Shown independent of --progress/--verbose, but NEVER under --json: stdout must stay pure
  // machine-readable JSON there (the notice would corrupt it, breaking `deploy --json` parsing for
  // any managed-memory harness). The notice is still captured in the deploy log via logger.log.
  // Clear any active spinner line first so the multi-line notice prints cleanly.
  const onNotice = options.json
    ? undefined
    : (message: string) => {
        if (spinner) {
          clearInterval(spinner);
          spinner = undefined;
          process.stdout.write('\r\x1b[K');
        }
        console.log(`\n${message}\n`);
      };

  const result = await handleDeploy({
    target: options.target!,
    autoConfirm: options.yes,
    verbose: options.verbose ?? options.diff,
    plan: options.plan,
    diff: options.diff,
    onProgress,
    onResourceEvent,
    onNotice,
  });

  if (spinner) {
    clearInterval(spinner);
    process.stdout.write('\r\x1b[K');
  }

  return result;
}

function printDeployResult(result: DeployResult & { success: true }, options: DeployOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  // Dependency sync warnings: downgraded skew, skipped specifiers. Informational
  // only — they must reach the terminal but must NOT flip the exit code to 2 (the bundled-tarball
  // override in e2e/dev builds is always "left unmanaged", and exit 2 would fail every deploy).
  if (result.dependencySyncResult?.warnings && result.dependencySyncResult.warnings.length > 0) {
    for (const warning of result.dependencySyncResult.warnings) {
      console.warn(`⚠ ${warning}`);
    }
  }

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

    if (result.postDeployWarnings && result.postDeployWarnings.length > 0) {
      console.log('\n⚠ Post-deploy warnings:');
      for (const warning of result.postDeployWarnings) {
        console.log(`  ${warning}`);
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
            requireTTY();
            await handleDeployTUI({ diffMode: true });
          } else {
            requireTTY();
            await handleDeployTUI();
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
