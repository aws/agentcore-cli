import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { PlanScreen } from '../../tui/screens/plan/PlanScreen';
import { handlePlan } from './actions';
import type { PlanOptions } from './types';
import { validatePlanOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

interface TUIOptions {
  autoConfirm?: boolean;
}

function handlePlanTUI(options: TUIOptions = {}): void {
  const { unmount } = render(
    <PlanScreen
      isInteractive={false}
      autoConfirm={options.autoConfirm}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />
  );
}

async function handlePlanCLI(options: PlanOptions): Promise<void> {
  const validation = validatePlanOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      render(<Text color="red">Error: {validation.error}</Text>);
    }
    process.exit(1);
  }

  const result = await handlePlan({
    target: options.target!,
    deploy: options.deploy,
    autoConfirm: options.yes,
  });

  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.success) {
    render(<Text color="green">{result.message}</Text>);
  } else {
    render(<Text color="red">Error: {result.error}</Text>);
  }

  process.exit(result.success ? 0 : 1);
}

export const registerPlan = (program: Command) => {
  program
    .command('plan')
    .description(COMMAND_DESCRIPTIONS.plan)
    .option('--target <target>', 'Deployment target name')
    .option('-y, --yes', 'Auto-confirm prompts (e.g., bootstrap)')
    .option('--json', 'Output as JSON')
    .option('--deploy', 'Deploy after successful plan')
    .action(async (cliOptions: { target?: string; yes?: boolean; json?: boolean; deploy?: boolean }) => {
      try {
        requireProject();
        if (cliOptions.target) {
          await handlePlanCLI(cliOptions as PlanOptions);
        } else {
          handlePlanTUI({ autoConfirm: cliOptions.yes });
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
