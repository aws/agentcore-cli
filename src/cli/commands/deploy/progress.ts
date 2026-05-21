import { ConfigIO } from '../../../lib';
import { detectAwsContext } from '../../aws/aws-context';
import { getErrorMessage } from '../../errors';
import { canSkipDeploy } from '../../operations/deploy/change-detection';
import { handleDeploy } from './actions';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SpinnerProgress {
  onProgress: (step: string, status: 'start' | 'success' | 'error') => void;
  cleanup: () => void;
}

export function createSpinnerProgress(): SpinnerProgress {
  let spinner: NodeJS.Timeout | undefined;

  const clearSpinner = () => {
    if (spinner) {
      clearInterval(spinner);
      spinner = undefined;
      process.stdout.write('\r\x1b[K');
    }
  };

  const onProgress = (step: string, status: 'start' | 'success' | 'error') => {
    clearSpinner();

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
  };

  return { onProgress, cleanup: clearSpinner };
}

export async function runCliDeploy(): Promise<void> {
  console.log('Deploying project resources...');
  const { onProgress, cleanup } = createSpinnerProgress();

  try {
    // Auto-populate aws-targets.json if empty
    const configIO = new ConfigIO();
    try {
      const targets = await configIO.readAWSDeploymentTargets();
      if (targets.length === 0) {
        const ctx = await detectAwsContext();
        if (ctx.accountId) {
          await configIO.writeAWSDeploymentTargets([{ name: 'default', account: ctx.accountId, region: ctx.region }]);
        }
      }
    } catch {
      // aws-targets.json doesn't exist — try to create it
      try {
        const ctx = await detectAwsContext();
        if (ctx.accountId) {
          await configIO.writeAWSDeploymentTargets([{ name: 'default', account: ctx.accountId, region: ctx.region }]);
        }
      } catch {
        // Can't detect — let handleDeploy fail with a clear error
      }
    }

    const noChanges = await canSkipDeploy(configIO);
    if (noChanges) {
      onProgress('No changes detected — skipping deploy', 'success');
      cleanup();
      console.log('');
      return;
    }

    const result = await handleDeploy({
      target: 'default',
      autoConfirm: true,
      onProgress,
    });
    cleanup();

    if (result.success) {
      console.log('Deploy complete.');
      if (result.logPath) {
        console.log(`Deploy log: ${result.logPath}`);
      }
      console.log('');
    } else {
      console.warn(`\x1b[33mDeploy failed: ${result.error}. Starting dev server anyway...\x1b[0m`);
      if (result.logPath) {
        console.warn(`Deploy log: ${result.logPath}`);
      }
      console.log('');
    }
  } catch (deployErr) {
    cleanup();
    console.warn(`\x1b[33mDeploy failed: ${getErrorMessage(deployErr)}. Starting dev server anyway...\x1b[0m\n`);
  }
}
