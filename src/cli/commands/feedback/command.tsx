import { runCliCommand } from '../../telemetry/cli-command-run.js';
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
        const { clear, unmount, waitUntilExit } = render(
          <FeedbackScreen
            initialScreenshot={options.screenshot}
            onExit={() => {
              clear();
              unmount();
            }}
          />
        );
        // Wait for the wizard to unmount, then exit. Without this Node sticks
        // around because of Ink's stdin raw-mode listeners.
        await waitUntilExit();
        process.exit(0);
      }

      const has_screenshot = !!options.screenshot;
      const knownAttrs = { mode: 'cli' as const, has_screenshot };

      await runCliCommand(
        'feedback',
        !!options.json,
        async () => {
          const outcome = await handleFeedback(message, options);

          if (outcome.kind === 'no-tty') {
            throw new Error('Feedback consent must be confirmed interactively. Re-run agentcore feedback in a TTY.');
          }
          if (outcome.kind === 'error') {
            throw outcome.error;
          }
          if (outcome.kind === 'declined') {
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: 'Feedback cancelled.' }));
            } else {
              console.log('Feedback cancelled. Nothing was submitted.');
            }
            return knownAttrs;
          }

          const result = outcome.result;
          if (options.json) {
            console.log(
              JSON.stringify({
                success: true,
                id: result.id,
                timestamp: result.timestamp,
                reference: result.reference,
              })
            );
          } else {
            render(<Text color="green">Thank you. Your feedback has been submitted (id: {result.id}).</Text>);
          }
          return knownAttrs;
        },
        knownAttrs
      );
    });
};
