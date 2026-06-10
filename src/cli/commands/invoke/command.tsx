import { ValidationError, serializeResult } from '../../../lib';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { isPreviewEnabled } from '../../feature-flags';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { renderTUI } from '../../tui';
import { requireProject, requireTTY } from '../../tui/guards';
import { parseHeaderFlags } from '../shared/header-utils';
import { type InvokeContext, handleHarnessInvokeByArn, handleInvoke, loadInvokeConfig } from './action';
import { resolvePrompt } from './resolve-prompt';
import type { InvokeOptions, InvokeResult } from './types';
import { computeInvokeAttrs } from './utils';
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

export function redactSensitiveText(value: string): string {
  return (
    value
      // AgentCore inbound bearer tokens are always CUSTOM_JWT/OIDC JWTs, and a JWT always begins
      // with `eyJ` (base64url of `{"`, the start of its header/payload JSON). Matching by shape
      // redacts the token wherever it appears and never touches prose like "bearer token".
      // See https://stackoverflow.com/a/74181595 (why JWTs start with `eyJ`).
      .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/(client[_-]?secret["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, '$1[REDACTED]')
      .replace(/((?:access[_-]?)?token["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, '$1[REDACTED]')
  );
}

function printInvokeResult(result: InvokeResult, options: InvokeOptions): void {
  if (options.json) {
    const serialized = serializeResult(result);
    if (typeof serialized.response === 'string') serialized.response = redactSensitiveText(serialized.response);
    if (typeof serialized.error === 'string') serialized.error = redactSensitiveText(serialized.error);
    console.log(JSON.stringify(serialized));
  } else if (options.stream) {
    if (result.sessionId) {
      console.error(`\nSession: ${result.sessionId}`);
      console.error(`To resume: agentcore invoke --session-id ${result.sessionId}`);
    }
    if (result.logFilePath) {
      console.error(`Log: ${result.logFilePath}`);
    }
  } else {
    if (result.success && result.response) {
      console.log(redactSensitiveText(result.response));
    } else if (!result.success && result.error) {
      console.error(redactSensitiveText(result.error.message));
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
    .option(
      '--exec',
      'Execute a shell command in the runtime container (use `agentcore exec` instead) [non-interactive]'
    )
    .option('--timeout <seconds>', 'Timeout in seconds for --exec commands [non-interactive]', parseInt)
    .option(
      '-H, --header <header>',
      'Custom header to forward to the agent (format: "Name: Value", repeatable) [non-interactive]',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option('--bearer-token <token>', 'Bearer token for CUSTOM_JWT auth (bypasses SigV4) [non-interactive]')
    .option('--payment-instrument-id <id>', 'Payment instrument ID for x402 payments [non-interactive]')
    .option('--payment-session-id <id>', 'Payment session ID for budget tracking [non-interactive]')
    .option('--auto-session', 'Auto-create/reuse a payment session for testing [non-interactive]')
    .option(
      '--payment-user-id <id>',
      'End-user identity (wallet owner) for payments; scopes the instrument/session/budget. Defaults to --user-id when omitted.'
    );

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
      .option('--skills <paths>', 'Skills to use, comma-separated paths (harness only) [non-interactive] [preview]')
      .option('--system-prompt <text>', 'Override system prompt (harness only) [non-interactive] [preview]')
      .option(
        '--allowed-tools <tools>',
        'Override allowed tools, comma-separated (harness only) [non-interactive] [preview]'
      )
      .option('--actor-id <id>', 'Override memory actor ID (harness only) [non-interactive] [preview]');
  }

  // Group the long flag list into labelled sections (mirrors `add ab-test`).
  // Core flags (prompt/prompt-file/runtime/target/session-id/user-id) stay in the
  // default "Options:" block; everything else is hidden there and re-listed under a
  // section heading below. Preview/harness sections are only emitted when registered.
  const hiddenFromDefaultHelp = new Set<string>([
    // Payments
    '--payment-user-id',
    '--payment-instrument-id',
    '--payment-session-id',
    '--auto-session',
    // Output
    '--json',
    '--stream',
    // MCP & advanced
    '--tool',
    '--input',
    '--exec',
    '--timeout',
    '--header',
    '--bearer-token',
    // Harness + model overrides (preview)
    '--harness',
    '--harness-arn',
    '--region',
    '--verbose',
    '--model-id',
    '--model-provider',
    '--api-key-arn',
    '--tools',
    '--max-iterations',
    '--max-tokens',
    '--harness-timeout',
    '--skills',
    '--system-prompt',
    '--allowed-tools',
    '--actor-id',
  ]);
  for (const opt of invokeCmd.options) {
    if (hiddenFromDefaultHelp.has(opt.long ?? '')) {
      opt.hidden = true;
    }
  }

  invokeCmd.addHelpText(
    'after',
    `
Payments [non-interactive]
  --payment-user-id <id>           End-user/wallet-owner identity (defaults to --user-id)
  --payment-instrument-id <id>     Payment instrument (wallet) ID
  --payment-session-id <id>        Payment session ID for budget tracking
  --auto-session                   Auto-create/reuse a payment session for testing

Output [non-interactive]
  --json                           Output as JSON
  --stream                         Stream response in real-time

MCP & Advanced [non-interactive]
  --tool <name>                    MCP tool name (use with "call-tool" prompt)
  --input <json>                   MCP tool arguments as JSON (use with --tool)
  --exec                           Execute a shell command in the runtime container
  --timeout <seconds>              Timeout in seconds for --exec commands
  -H, --header <header>            Custom header "Name: Value" (repeatable)
  --bearer-token <token>           Bearer token for CUSTOM_JWT auth (bypasses SigV4)
`
  );

  if (isPreviewEnabled()) {
    invokeCmd.addHelpText(
      'after',
      `
Harness [non-interactive] [preview]
  --harness <name>                 Select specific harness to invoke
  --harness-arn <arn>              Invoke a harness by ARN (no project required)
  --region <region>                AWS region (required with --harness-arn)
  --verbose                        Print verbose streaming JSON events

Model & Runtime Overrides (harness only) [non-interactive] [preview]
  --model-id <id>                  Override model
  --model-provider <provider>      bedrock, open_ai, or gemini
  --api-key-arn <arn>              API key ARN for open_ai/gemini
  --tools <tools>                  Override tools (comma-separated)
  --allowed-tools <tools>          Override allowed tools (comma-separated)
  --skills <paths>                 Skills (comma-separated paths)
  --system-prompt <text>           Override system prompt
  --actor-id <id>                  Override memory actor ID
  --max-iterations <n>             Override max iterations
  --max-tokens <n>                 Override max tokens
  --harness-timeout <seconds>      Override timeout seconds
`
    );
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
        skills?: string;
        systemPrompt?: string;
        allowedTools?: string;
        actorId?: string;
        paymentInstrumentId?: string;
        paymentSessionId?: string;
        autoSession?: boolean;
        paymentUserId?: string;
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
          // Payment params (--auto-session / --payment-instrument-id /
          // --payment-session-id / --payment-user-id) do NOT force CLI mode on
          // their own — with a prompt they run one-shot (resolved.prompt above),
          // without a prompt they carry into the interactive TUI. --auto-session
          // mints/reuses a session at TUI start; see useInvokeFlow.
        ) {
          const result = await withCommandRunTelemetry(
            'invoke',
            computeInvokeAttrs({
              preview: isPreviewEnabled(),
              harnessName: cliOptions.harness,
              harnessArn: cliOptions.harnessArn,
              harnessCount: invokeContext?.project.harnesses?.length ?? 0,
              runtimeCount: invokeContext?.project.runtimes.length ?? 0,
              stream: cliOptions.stream ?? false,
              hasSessionId: !!cliOptions.sessionId,
              bearerToken: cliOptions.bearerToken,
              agentProtocol: agentProtocol ?? (cliOptions.tool ? 'mcp' : undefined),
            }),
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
                skills: cliOptions.skills,
                systemPrompt: cliOptions.systemPrompt,
                allowedTools: cliOptions.allowedTools,
                actorId: cliOptions.actorId,
                paymentInstrumentId: cliOptions.paymentInstrumentId,
                paymentSessionId: cliOptions.paymentSessionId,
                autoSession: cliOptions.autoSession,
                paymentUserId: cliOptions.paymentUserId,
              };

              return handleInvokeCLI(options, invokeContext);
            }
          );

          printInvokeResult(result, {
            json: cliOptions.json,
            stream: cliOptions.stream,
          });
          process.exit(result.exitCode ?? (result.success ? 0 : 1));
        } else {
          // No CLI options - interactive TUI mode (headers still passed if provided)

          // Validate flag combinations BEFORE the TTY check: a conflicting
          // --auto-session + --payment-session-id is wrong regardless of terminal,
          // and the flag-conflict message is clearer than the TTY guard. Single
          // source of truth: validateInvokeOptions.
          const validation = validateInvokeOptions({
            autoSession: cliOptions.autoSession,
            paymentSessionId: cliOptions.paymentSessionId,
          });
          if (!validation.valid) {
            console.error(validation.error);
            process.exit(1);
          }

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
              paymentInstrumentId: cliOptions.paymentInstrumentId,
              paymentSessionId: cliOptions.paymentSessionId,
              autoSession: cliOptions.autoSession,
              // Default the payments wallet-owner identity to --user-id when
              // --payment-user-id is omitted (same fallback as the command path).
              paymentUserId: cliOptions.paymentUserId ?? cliOptions.userId,
            },
            enterAltScreen: false,
            actionOnBack: 'exit',
            isInteractive: false,
          });
        }
      } catch (error) {
        const msg = redactSensitiveText(getErrorMessage(error));
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          render(<Text color="red">Error: {msg}</Text>);
        }
        process.exit(1);
      }
    }
  );
};
