import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { InvokeScreen } from '../../tui/screens/invoke';
import { handleInvoke, loadInvokeConfig } from './action';
import type { InvokeOptions } from './types';
import { validateInvokeOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(message: string): NodeJS.Timeout {
  let i = 0;
  process.stderr.write(`${SPINNER_FRAMES[0]} ${message}`);
  return setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length;
    process.stderr.write(`\r${SPINNER_FRAMES[i]} ${message}`);
  }, 80);
}

function stopSpinner(spinner: NodeJS.Timeout): void {
  clearInterval(spinner);
  process.stderr.write('\r\x1b[K'); // Clear line
}

async function handleInvokeCLI(options: InvokeOptions): Promise<void> {
  const validation = validateInvokeOptions(options);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: validation.error }));
    } else {
      console.error(validation.error);
    }
    process.exit(1);
  }

  let spinner: NodeJS.Timeout | undefined;

  try {
    const context = await loadInvokeConfig();

    // Show spinner for non-streaming, non-json invocations
    if (!options.stream && !options.json) {
      spinner = startSpinner('Invoking agent...');
    }

    const result = await handleInvoke(context, options);

    if (spinner) {
      stopSpinner(spinner);
    }

    if (options.json) {
      console.log(JSON.stringify(result));
    } else if (options.stream) {
      // Streaming already wrote to stdout, just show log path
      if (result.logFilePath) {
        console.error(`\nLog: ${result.logFilePath}`);
      }
    } else {
      // Non-streaming, non-json: print response
      if (result.response) {
        console.log(result.response);
      }
      if (result.logFilePath) {
        console.error(`\nLog: ${result.logFilePath}`);
      }
    }

    process.exit(result.success ? 0 : 1);
  } catch (err) {
    if (spinner) {
      stopSpinner(spinner);
    }
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: getErrorMessage(err) }));
    } else {
      console.error(getErrorMessage(err));
    }
    process.exit(1);
  }
}

export const registerInvoke = (program: Command) => {
  program
    .command('invoke')
    .alias('i')
    .description(COMMAND_DESCRIPTIONS.invoke)
    .argument('[prompt]', 'Prompt to send to the agent')
    .option('--prompt <text>', 'Prompt to send to the agent')
    .option('--agent <name>', 'Select specific agent')
    .option('--target <name>', 'Select deployment target')
    .option('--session-id <id>', 'Use specific session ID for conversation continuity')
    .option('--new-session', 'Start a new session (ignores existing session)')
    .option('--json', 'Output as JSON')
    .option('--stream', 'Stream response in real-time')
    .action(
      async (
        positionalPrompt: string | undefined,
        cliOptions: {
          prompt?: string;
          agent?: string;
          target?: string;
          sessionId?: string;
          newSession?: boolean;
          json?: boolean;
          stream?: boolean;
        }
      ) => {
        try {
          requireProject();
          // --prompt flag takes precedence over positional argument
          const prompt = cliOptions.prompt ?? positionalPrompt;

          if (prompt) {
            // Prompt provided - use CLI handler for clean output
            await handleInvokeCLI({
              prompt,
              agentName: cliOptions.agent,
              targetName: cliOptions.target ?? 'default',
              json: cliOptions.json,
              stream: cliOptions.stream,
            });
          } else {
            // No prompt - interactive TUI mode
            const { waitUntilExit } = render(
              <InvokeScreen
                isInteractive={true}
                onExit={() => process.exit(0)}
                initialSessionId={cliOptions.sessionId}
                forceNewSession={cliOptions.newSession}
              />
            );
            await waitUntilExit();
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
