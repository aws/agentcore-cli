import { type Result, ValidationError, serializeResult } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { AuthType, Protocol, standardize } from '../../telemetry/schemas/common-shapes.js';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject, requireTTY } from '../../tui/guards';
import { InvokeScreen } from '../../tui/screens/invoke';
import { parseHeaderFlags } from '../shared/header-utils';
import { type InvokeContext, handleInvoke, loadInvokeConfig } from './action';
import { resolvePrompt } from './resolve-prompt';
import type { InvokeOptions, InvokeResult } from './types';
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

function resolveProtocol(options: InvokeOptions, projectProtocol?: string): string {
  if (projectProtocol) return projectProtocol.toLowerCase();
  if (options.tool) return 'mcp';
  return 'http';
}

async function handleInvokeCLI(options: InvokeOptions, preloadedContext?: InvokeContext): Promise<InvokeResult> {
  const validation = validateInvokeOptions(options);
  if (!validation.valid) {
    return { success: false, error: new ValidationError(validation.error ?? 'Validation failed') };
  }

  let spinner: NodeJS.Timeout | undefined;

  try {
    const context = preloadedContext ?? (await loadInvokeConfig());

    // Show spinner for non-streaming, non-json, non-exec invocations
    if (!options.stream && !options.json && !options.exec) {
      spinner = startSpinner('Invoking agent...');
    }

    const result = await handleInvoke(context, options);

    if (spinner) {
      stopSpinner(spinner);
    }

    return result;
  } catch (err) {
    if (spinner) {
      stopSpinner(spinner);
    }
    throw err;
  }
}

function printInvokeResult(result: InvokeResult, options: InvokeOptions): void {
  if (options.json) {
    console.log(JSON.stringify(serializeResult(result)));
  } else if (options.stream) {
    // Streaming already wrote to stdout, just show session and log path
    if (result.sessionId) {
      console.error(`\nSession: ${result.sessionId}`);
      console.error(`To resume: agentcore invoke --session-id ${result.sessionId}`);
    }
    if (result.logFilePath) {
      console.error(`Log: ${result.logFilePath}`);
    }
  } else {
    // Non-streaming, non-json: print provider info and response or error
    if (result.success && result.response) {
      console.log(result.response);
    } else if (!result.success && result.error) {
      console.error(result.error.message);
    }
    if (result.sessionId) {
      console.error(`\nSession: ${result.sessionId}`);
      console.error(`To resume: agentcore invoke --session-id ${result.sessionId}`);
    }
    if (result.logFilePath) {
      console.error(`Log: ${result.logFilePath}`);
    }
  }
}

export const registerInvoke = (program: Command) => {
  program
    .command('invoke')
    .alias('i')
    .description(COMMAND_DESCRIPTIONS.invoke)
    .argument(
      '[prompt]',
      'Prompt to send to the agent. Also accepts piped stdin when no prompt is provided and stdin is not a TTY [non-interactive]'
    )
    .option('--prompt <text>', 'Prompt to send to the agent [non-interactive]')
    .option(
      '--prompt-file <path>',
      'Read the prompt from a file (for long or structured payloads that exceed shell arg limits) [non-interactive]'
    )
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
          promptFile?: string;
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

          // Load config once for protocol resolution and to pass into handleInvokeCLI
          let invokeContext: InvokeContext | undefined;
          let agentProtocol: string | undefined;
          try {
            invokeContext = await loadInvokeConfig();
            const agent = cliOptions.runtime
              ? invokeContext.project.runtimes.find(a => a.name === cliOptions.runtime)
              : invokeContext.project.runtimes[0];
            agentProtocol = agent?.protocol;
          } catch {
            // Config load failure will be caught again inside handleInvokeCLI
          }

          // Resolve prompt from flag / positional / --prompt-file / stdin
          const resolved = await resolvePrompt({
            flag: cliOptions.prompt,
            positional: positionalPrompt,
            file: cliOptions.promptFile,
            stdinPiped: !process.stdin.isTTY,
          });

          // CLI mode if any CLI-specific options provided, prompt resolved, or prompt resolution failed
          // (follows deploy command pattern)
          if (
            !resolved.success ||
            resolved.prompt !== undefined ||
            cliOptions.json ||
            cliOptions.target ||
            cliOptions.stream ||
            cliOptions.runtime ||
            cliOptions.tool ||
            cliOptions.exec ||
            cliOptions.bearerToken
          ) {
            const result = await withCommandRunTelemetry(
              'invoke',
              {
                has_stream: cliOptions.stream ?? false,
                has_session_id: !!cliOptions.sessionId,
                auth_type: standardize(AuthType, cliOptions.bearerToken ? 'bearer_token' : 'sigv4'),
                protocol: standardize(
                  Protocol,
                  resolveProtocol({ tool: cliOptions.tool } as InvokeOptions, agentProtocol)
                ),
              },
              async (): Promise<InvokeResult> => {
                if (!resolved.success) {
                  return { success: false, error: new ValidationError(resolved.error ?? 'Prompt resolution failed') };
                }

                // Parse custom headers
                let headers: Record<string, string> | undefined;
                if (cliOptions.header && cliOptions.header.length > 0) {
                  headers = parseHeaderFlags(cliOptions.header);
                }

                const options: InvokeOptions = {
                  prompt: resolved.prompt,
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
                };

                return handleInvokeCLI(options, invokeContext);
              }
            );

            printInvokeResult(result, {
              json: cliOptions.json,
              stream: cliOptions.stream,
            });
            process.exit(result.success ? 0 : 1);
          } else {
            // No CLI options - interactive TUI mode (headers still passed if provided)
            requireTTY();

            // Parse custom headers for TUI mode
            let headers: Record<string, string> | undefined;
            if (cliOptions.header && cliOptions.header.length > 0) {
              headers = parseHeaderFlags(cliOptions.header);
            }

            const tuiResult = await withCommandRunTelemetry(
              'invoke',
              {
                has_stream: true,
                has_session_id: !!cliOptions.sessionId,
                auth_type: standardize(AuthType, cliOptions.bearerToken ? 'bearer_token' : 'sigv4'),
                protocol: standardize(Protocol, resolveProtocol({}, agentProtocol)),
              },
              async (): Promise<Result> => {
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
                return { success: true };
              }
            );
            if (!tuiResult.success) {
              render(<Text color="red">Error: {getErrorMessage(tuiResult.error)}</Text>);
              process.exit(1);
            }
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
