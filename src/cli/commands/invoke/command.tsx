import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { InvokeScreen } from '../../tui/screens/invoke';
import { parseHeaderFlags } from '../shared/header-utils';
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

    // Show spinner for non-streaming, non-json, non-exec invocations
    if (!options.stream && !options.json && !options.exec) {
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
      // Non-streaming, non-json: print provider info and response or error
      if (result.success && result.response) {
        console.log(result.response);
      } else if (!result.success && result.error) {
        console.error(result.error);
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
    .argument('[prompt]', 'Prompt to send to the agent [non-interactive]')
    .option('--prompt <text>', 'Prompt to send to the agent [non-interactive]')
    .option('--runtime <name>', 'Select specific runtime [non-interactive]')
    .option('--target <name>', 'Select deployment target [non-interactive]')
    .option('--session-id <id>', 'Use specific session ID for conversation continuity')
    .option('--user-id <id>', 'User ID for runtime invocation (default: "default-user")')
    .option('--json', 'Output as JSON [non-interactive]')
    .option('--stream', 'Stream response in real-time (TUI streams by default) [non-interactive]')
    .option('--tool <name>', 'MCP tool name (use with "call-tool" prompt) [non-interactive]')
    .option('--input <json>', 'MCP tool arguments as JSON (use with --tool) [non-interactive]')
    .option('--exec', 'Execute a shell command in the runtime container [non-interactive]')
    .option('--timeout <seconds>', 'Timeout in seconds for --exec commands [non-interactive]', parseInt)
    .option(
      '-H, --header <header>',
      'Custom header to forward to the agent (format: "Name: Value", repeatable) [non-interactive]',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option('--bearer-token <token>', 'Bearer token for CUSTOM_JWT auth (bypasses SigV4) [non-interactive]')
    .action(
      async (
        positionalPrompt: string | undefined,
        cliOptions: {
          prompt?: string;
          runtime?: string;
          target?: string;
          sessionId?: string;
          userId?: string;
          json?: boolean;
          stream?: boolean;
          tool?: string;
          input?: string;
          exec?: boolean;
          timeout?: number;
          header?: string[];
          bearerToken?: string;
        }
      ) => {
        try {
          requireProject();
          // --prompt flag takes precedence over positional argument
          const prompt = cliOptions.prompt ?? positionalPrompt;

          // Parse custom headers
          let headers: Record<string, string> | undefined;
          if (cliOptions.header && cliOptions.header.length > 0) {
            headers = parseHeaderFlags(cliOptions.header);
          }

          // CLI mode if any CLI-specific options provided (follows deploy command pattern)
          if (
            prompt ||
            cliOptions.json ||
            cliOptions.target ||
            cliOptions.stream ||
            cliOptions.runtime ||
            cliOptions.tool ||
            cliOptions.exec ||
            cliOptions.bearerToken
          ) {
            await handleInvokeCLI({
              prompt,
              agentName: cliOptions.runtime,
              targetName: cliOptions.target ?? 'default',
              sessionId: cliOptions.sessionId,
              userId: cliOptions.userId,
              json: cliOptions.json,
              stream: cliOptions.stream,
              tool: cliOptions.tool,
              input: cliOptions.input,
              exec: cliOptions.exec,
              timeout: cliOptions.timeout,
              headers,
              bearerToken: cliOptions.bearerToken,
            });
          } else {
            // No CLI options - interactive TUI mode (headers still passed if provided)
            const { waitUntilExit, unmount } = render(
              <InvokeScreen
                isInteractive={true}
                onExit={() => unmount()}
                initialSessionId={cliOptions.sessionId}
                initialUserId={cliOptions.userId}
                initialHeaders={headers}
                initialBearerToken={cliOptions.bearerToken}
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
