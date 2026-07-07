import { ConfigIO } from '../../../lib';
import { ANSI } from '../../constants';
import { getErrorMessage } from '../../errors';
import { ensureDefaultDeploymentTarget } from '../../operations/deploy';
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
      process.stdout.write(`\r${ANSI.clearLine}`);
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
    // Auto-populate aws-targets.json if empty (best-effort). handleDeploy also
    // does this, but we run it here first so canSkipDeploy sees a populated target.
    const configIO = new ConfigIO();
    await ensureDefaultDeploymentTarget(configIO);

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
      console.warn(`${ANSI.yellow}Deploy failed: ${result.error}. Starting dev server anyway...${ANSI.reset}`);
      if (result.logPath) {
        console.warn(`Deploy log: ${result.logPath}`);
      }
      console.log('');
    }
  } catch (deployErr) {
    cleanup();
    console.warn(
      `${ANSI.yellow}Deploy failed: ${getErrorMessage(deployErr)}. Starting dev server anyway...${ANSI.reset}\n`
    );
  }
}
