import { ValidationError, serializeResult } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { isPreviewEnabled } from '../../feature-flags';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { AgentProtocol, AuthType, standardize } from '../../telemetry/schemas/common-shapes.js';
import { renderTUI } from '../../tui';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject, requireTTY } from '../../tui/guards';
import { parseHeaderFlags } from '../shared/header-utils';
import { type InvokeContext, handleHarnessInvokeByArn, handleInvoke, loadInvokeConfig } from './action';
import { resolvePrompt } from './resolve-prompt';
import type { InvokeOptions, InvokeResult } from './types';
import { validateInvokeOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

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
    // Preview: direct harness invoke by ARN (no project required)
    if (isPreviewEnabled() && options.harnessArn) {
      const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) {
        const msg = '--region is required with --harness-arn (or set AWS_REGION)';
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
      return handleHarnessInvokeByArn(options.harnessArn, region, options);
    }

    const context = preloadedContext ?? (await loadInvokeConfig());

    // Show spinner for non-streaming, non-json, non-exec invocations
    // Harness invoke always streams directly to stdout, so skip spinner for harness
    const isHarness =
      isPreviewEnabled() &&
      (options.harnessName != null ||
        ((context.project.harnesses ?? []).length > 0 && context.project.runtimes.length === 0));
    if (!options.stream && !options.json && !options.exec && !isHarness) {
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
  const invokeCmd = program
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
    .option('--bearer-token <token>', 'Bearer token for CUSTOM_JWT auth (bypasses SigV4) [non-interactive]');

  if (isPreviewEnabled()) {
    invokeCmd
      .option('--harness <name>', 'Select specific harness to invoke [non-interactive] [preview]')
      .option('--harness-arn <arn>', 'Invoke a harness by ARN (no project required) [non-interactive] [preview]')
      .option(
        '--region <region>',
        'AWS region (required with --harness-arn when no project) [non-interactive] [preview]'
      )
      .option('--verbose', 'Print verbose streaming JSON events (harness only) [non-interactive] [preview]')
      .option('--model-id <id>', 'Override model for this invocation (harness only) [non-interactive] [preview]')
      .option(
        '--model-provider <provider>',
        'Override model provider: bedrock, open_ai, gemini (harness only) [non-interactive] [preview]'
      )
      .option(
        '--api-key-arn <arn>',
        'Override API key ARN for open_ai/gemini (harness only) [non-interactive] [preview]'
      )
      .option('--tools <tools>', 'Override tools, comma-separated (harness only) [non-interactive] [preview]')
      .option('--max-iterations <n>', 'Override max iterations (harness only) [non-interactive] [preview]', parseInt)
      .option('--max-tokens <n>', 'Override max tokens (harness only) [non-interactive] [preview]', parseInt)
      .option(
        '--harness-timeout <seconds>',
        'Override timeout seconds (harness only) [non-interactive] [preview]',
        parseInt
      )
      .option('--system-prompt <text>', 'Override system prompt (harness only) [non-interactive] [preview]')
      .option(
        '--allowed-tools <tools>',
        'Override allowed tools, comma-separated (harness only) [non-interactive] [preview]'
      )
      .option('--actor-id <id>', 'Override memory actor ID (harness only) [non-interactive] [preview]');
  }

  invokeCmd.action(
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
        harness?: string;
        harnessArn?: string;
        region?: string;
        verbose?: boolean;
        modelId?: string;
        modelProvider?: string;
        apiKeyArn?: string;
        tools?: string;
        maxIterations?: number;
        maxTokens?: number;
        harnessTimeout?: number;
        systemPrompt?: string;
        allowedTools?: string;
        actorId?: string;
      }
    ) => {
      try {
        // Skip requireProject when --harness-arn provided (preview mode)
        if (!(isPreviewEnabled() && cliOptions.harnessArn)) {
          requireProject();
        }

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
          cliOptions.bearerToken ||
          cliOptions.harness ||
          cliOptions.harnessArn ||
          cliOptions.verbose
        ) {
          const result = await withCommandRunTelemetry(
            'invoke',
            {
              has_stream: cliOptions.stream ?? false,
              has_session_id: !!cliOptions.sessionId,
              auth_type: standardize(AuthType, cliOptions.bearerToken ? 'bearer_token' : 'sigv4'),
              agent_protocol: standardize(
                AgentProtocol,
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
                harnessName: cliOptions.harness,
                harnessArn: cliOptions.harnessArn,
                region: cliOptions.region,
                verbose: cliOptions.verbose,
                modelId: cliOptions.modelId,
                modelProvider: cliOptions.modelProvider,
                apiKeyArn: cliOptions.apiKeyArn,
                tools: cliOptions.tools,
                maxIterations: cliOptions.maxIterations,
                maxTokens: cliOptions.maxTokens,
                harnessTimeout: cliOptions.harnessTimeout,
                systemPrompt: cliOptions.systemPrompt,
                allowedTools: cliOptions.allowedTools,
                actorId: cliOptions.actorId,
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

          await renderTUI({
            initialRoute: {
              name: 'invoke',
              sessionId: cliOptions.sessionId,
              userId: cliOptions.userId,
              headers,
              bearerToken: cliOptions.bearerToken,
            },
            enterAltScreen: false,
            actionOnBack: 'exit',
            isInteractive: false,
          });
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
