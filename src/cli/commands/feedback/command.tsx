import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireTTY } from '../../tui/guards/tty';
import { FeedbackScreen } from '../../tui/screens/feedback';
import { handleFeedback } from './action';
import type { FeedbackOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

export const registerFeedback = (program: Command) => {
  return program
    .command('feedback')
    .description(COMMAND_DESCRIPTIONS.feedback)
    .argument('[message]', 'Feedback message [non-interactive]')
    .option('--screenshot <path>', 'Path to a PNG or JPG screenshot (max 100MB) [non-interactive]')
    .option('--json', 'Output result as JSON [non-interactive]')
    .action(async (message: string | undefined, cliOptions: Record<string, unknown>) => {
      const options = cliOptions as FeedbackOptions;

      if (message === undefined) {
        if (options.json) {
          console.error('Error: --json requires a feedback message argument.');
          process.exit(1);
          return;
        }
        requireTTY();
        const { clear, unmount } = render(
          <FeedbackScreen
            initialScreenshot={options.screenshot}
            onExit={() => {
              clear();
              unmount();
            }}
          />
        );
        return;
      }

      let outcome;
      try {
        outcome = await handleFeedback(message, options);
      } catch (error) {
        const errMessage = getErrorMessage(error);
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: errMessage }));
        } else {
          render(<Text color="red">Error: {errMessage}</Text>);
        }
        process.exit(1);
        return;
      }

      if (outcome.kind === 'no-tty') {
        const errorText = 'Feedback consent must be confirmed interactively. Re-run agentcore feedback in a TTY.';
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: errorText }));
        } else {
          console.error(errorText);
        }
        process.exit(1);
        return;
      }

      if (outcome.kind === 'declined') {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'Feedback cancelled.' }));
        } else {
          console.log('Feedback cancelled. Nothing was submitted.');
        }
        return;
      }

      if (outcome.kind === 'error') {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: outcome.error }));
        } else {
          render(<Text color="red">Error: {outcome.error}</Text>);
        }
        process.exit(1);
        return;
      }

      const result = outcome.result;
      if (options.json) {
        console.log(
          JSON.stringify({ success: true, id: result.id, timestamp: result.timestamp, reference: result.reference })
        );
        return;
      }

      render(<Text color="green">Thank you. Your feedback has been submitted (id: {result.id}).</Text>);
    });
};
