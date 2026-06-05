import { findConfigRoot } from '../../../lib';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { requireProject, requireTTY } from '../../tui/guards';
import { ExecScreen } from '../../tui/screens/exec';
import { handleExecOneShot, handleShellSession, loadExecContext, runInteractiveShell } from './action';
import type { ExecOptions, ExecResult } from './types';
import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

function printExecResult(result: ExecResult, json: boolean | undefined): void {
  if (json) {
    console.log(
      JSON.stringify({
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      })
    );
  } else if (!result.success && result.error) {
    console.error(`Error: ${result.error.message}`);
  }
}

export const registerExec = (program: Command) => {
  program
    .command('exec')
    .description(COMMAND_DESCRIPTIONS.exec)
    .argument('[command...]', 'Command to execute (one-shot mode, non-interactive)')
    .option('--it', 'Open an interactive PTY shell session')
    .option('--runtime <name|arn>', 'Target agent name or runtime ARN (skips agent picker)')
    .option('--session-id <id>', 'Pin to a specific runtime session / VM')
    .option('--shell-id <id>', 'Reconnect to an existing shell')
    .option('--region <region>', 'AWS region')
    .option('--bearer-token <token>', 'Bearer token for CUSTOM_JWT authentication (skips SigV4)')
    .option('--target <name>', 'Deployment target name (from agentcore.json)')
    .option('--timeout <seconds>', 'Timeout in seconds for one-shot commands', v => parseInt(v, 10))
    .option('--json', 'Output result as JSON (one-shot mode only, incompatible with --it)')
    .action(
      async (
        commandArgs: string[],
        cliOptions: {
          it?: boolean;
          runtime?: string;
          sessionId?: string;
          shellId?: string;
          region?: string;
          bearerToken?: string;
          target?: string;
          timeout?: number;
          json?: boolean;
        }
      ) => {
        try {
          // Skip project check only when --runtime is a full ARN: the user has all the
          // information they need without an agentcore.json in the working directory.
          // A name-based --runtime still requires the project to resolve the ARN.
          if (!cliOptions.runtime?.startsWith('arn:')) {
            if (cliOptions.json) {
              // requireProject() renders Ink and calls process.exit — bypass it in JSON mode
              // so we can emit a machine-readable error instead.
              if (!findConfigRoot()) {
                console.log(JSON.stringify({ success: false, error: 'No agentcore project found.' }));
                process.exit(1);
              }
            } else {
              requireProject();
            }
          }

          if (cliOptions.it && cliOptions.json) {
            console.error('Error: --json cannot be used with --it (PTY sessions are not JSON-serializable)');
            process.exit(1);
          }

          if (cliOptions.it && cliOptions.timeout !== undefined) {
            console.error('Error: --timeout cannot be used with --it (timeouts apply to one-shot commands only)');
            process.exit(1);
          }

          if (!cliOptions.it && cliOptions.bearerToken) {
            console.error(
              'Error: --bearer-token is only supported with --it (bearer token auth is not supported for one-shot commands)'
            );
            process.exit(1);
          }

          if (cliOptions.timeout !== undefined && (isNaN(cliOptions.timeout) || cliOptions.timeout < 0)) {
            console.error('Error: --timeout must be a non-negative integer (seconds)');
            process.exit(1);
          }

          if (
            cliOptions.sessionId !== undefined &&
            (cliOptions.sessionId.length < 33 || cliOptions.sessionId.length > 256)
          ) {
            console.error('Error: --session-id must be between 33 and 256 characters');
            process.exit(1);
          }

          const options: ExecOptions = {
            runtimeArn: cliOptions.runtime,
            sessionId: cliOptions.sessionId,
            shellId: cliOptions.shellId,
            interactive: cliOptions.it,
            command: commandArgs.length > 0 ? commandArgs : undefined,
            region: cliOptions.region,
            bearerToken: cliOptions.bearerToken,
            targetName: cliOptions.target,
            timeout: cliOptions.timeout,
            json: cliOptions.json,
          };

          // ── One-shot mode ──────────────────────────────────────────────────
          if (!options.interactive) {
            if (!options.command || options.command.length === 0) {
              console.error(
                'Usage:\n  agentcore exec <command>          one-shot\n  agentcore exec --it                 interactive shell'
              );
              process.exit(1);
            }

            const result: ExecResult = await withCommandRunTelemetry(
              'exec',
              {
                interactive: false,
                has_runtime: Boolean(options.runtimeArn),
                has_shell_id: Boolean(options.shellId),
                has_session_id: Boolean(options.sessionId),
                is_one_shot: true,
                auth_type: options.bearerToken ? 'bearer_token' : 'sigv4',
                is_reconnect: false,
                exit_code: 1,
                reconnect_attempts: 0,
                was_kicked: false,
              },
              async recorder => {
                const ctx = await loadExecContext(options);
                const r = await handleExecOneShot(ctx, options);
                recorder.set({ exit_code: r.exitCode ?? (r.success ? 0 : 1) });
                return r;
              }
            );
            printExecResult(result, cliOptions.json);
            process.exit(result.exitCode ?? (result.success ? 0 : 1));
          }

          // ── Interactive mode ───────────────────────────────────────────────
          // With --runtime: skip agent picker, go straight to PTY
          if (options.runtimeArn) {
            requireTTY();
            await runInteractiveShell(options);
            process.exit(0);
          }

          // Without --runtime: mount ExecScreen to let user pick agent, then PTY, then loop
          requireTTY();
          await runExecLoop(options);
          process.exit(0);
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(getErrorMessage(error));
          }
          process.exit(1);
        }
      }
    );
};

/**
 * ExecScreen picker loop: pick agent → PTY → back to picker (or quit).
 * Used both by `agentcore exec --it` (no --runtime) and from the TUI exit-action path (cli.ts).
 */
export async function runExecLoop(options: ExecOptions = {}): Promise<void> {
  while (true) {
    const picked = await pickAgent();
    if (!picked) break; // user pressed Esc

    const shellOptions: ExecOptions = { ...options, runtimeArn: picked.runtimeArn, sessionId: picked.sessionId };

    let sessionError: unknown;
    try {
      const sessionResult = await withCommandRunTelemetry(
        'exec',
        {
          interactive: true,
          has_runtime: Boolean(shellOptions.runtimeArn),
          has_shell_id: Boolean(shellOptions.shellId),
          has_session_id: Boolean(shellOptions.sessionId),
          is_one_shot: false,
          auth_type: shellOptions.bearerToken ? 'bearer_token' : 'sigv4',
          is_reconnect: false,
          exit_code: 1,
          reconnect_attempts: 0,
          was_kicked: false,
        },
        async recorder => {
          const ctx = await loadExecContext(shellOptions);
          const r = await handleShellSession(ctx, shellOptions);
          recorder.set({
            is_reconnect: r.isReconnect ?? Boolean(shellOptions.shellId),
            exit_code: r.exitCode ?? (r.success ? 0 : 1),
            reconnect_attempts: r.reconnectAttempts ?? 0,
            was_kicked: r.wasKicked ?? false,
          });
          return r;
        }
      );

      if (!sessionResult.success && sessionResult.error) sessionError = sessionResult.error;
    } catch (err) {
      sessionError = err;
    }

    // When agent was auto-selected (only one available), there's no picker to return to —
    // re-throw so the caller can surface the error before re-rendering the TUI.
    if (picked.autoSelected) {
      if (sessionError) {
        throw sessionError instanceof Error ? sessionError : new Error(`exec failed: ${JSON.stringify(sessionError)}`);
      }
      break;
    }

    // Clear PTY output so Ink picker remounts on a clean screen.
    process.stdout.write('\x1b[2J\x1b[H');
    // Manual pick: loop back to picker (error already printed inline by handleShellSession)
  }
}

interface PickResult {
  runtimeArn: string;
  sessionId?: string;
  autoSelected?: boolean;
}

function pickAgent(): Promise<PickResult | null> {
  return new Promise<PickResult | null>(resolve => {
    let resolved = false;

    const { unmount } = render(
      <ExecScreen
        onSelect={result => {
          if (resolved) return;
          resolved = true;
          unmount();
          process.stdout.write('\x1b[2J\x1b[H');
          resolve({ runtimeArn: result.runtimeArn, sessionId: result.sessionId, autoSelected: result.autoSelected });
        }}
        onExit={() => {
          if (!resolved) {
            resolved = true;
            unmount();
            resolve(null);
          }
        }}
      />
    );
  });
}
