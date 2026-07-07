import { ConfigIO } from '../../../lib';
import { executeBashCommand } from '../../aws/agentcore';
import { connectShell, startKeepalive } from '../../aws/connect-shell';
import { ShellChannel, ShellFramer, parseStatusFrame } from '../../aws/shell-framer';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import type { ExecOptions, ExecResult } from './types';
import { randomUUID } from 'crypto';
import type WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface ExecContext {
  region: string;
  runtimeArn: string;
}

/** Resolve region + runtimeArn from options and/or agentcore.json deployed state.
 *  --runtime accepts either a full ARN (arn:...) or an agent name from deployed state.
 */
export async function loadExecContext(options: ExecOptions, configIO: ConfigIO = new ConfigIO()): Promise<ExecContext> {
  // Short-circuit: explicit ARN + region — no need to read deployed state
  if (options.runtimeArn?.startsWith('arn:') && options.region) {
    return { region: options.region, runtimeArn: options.runtimeArn };
  }

  const awsTargets = await configIO.readAWSDeploymentTargets();
  const deployedState = await configIO.readDeployedState();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  if (options.targetName && !targetNames.includes(options.targetName)) {
    throw new Error(
      `Deployment target '${options.targetName}' not found. Available targets: ${targetNames.join(', ')}`
    );
  }

  const targetName = options.targetName ?? targetNames[0]!;
  const targetConfig = awsTargets.find(t => t.name === targetName);
  if (!targetConfig) {
    throw new Error(`Deployment target config '${targetName}' not found in aws-targets.`);
  }

  const targetState = deployedState.targets[targetName];
  const runtimeKeys = Object.keys(targetState?.resources?.runtimes ?? {});
  if (runtimeKeys.length === 0) {
    throw new Error(`No deployed runtimes found in target '${targetName}'.`);
  }

  // --runtime <arn> with no --region: ARN provided but region must come from config
  if (options.runtimeArn?.startsWith('arn:')) {
    return { region: options.region ?? targetConfig.region, runtimeArn: options.runtimeArn };
  }

  // --runtime <name>: look up by agent name in deployed state
  if (options.runtimeArn) {
    const agentState = targetState?.resources?.runtimes?.[options.runtimeArn];
    if (!agentState?.runtimeArn) {
      throw new Error(
        `Agent '${options.runtimeArn}' not found in target '${targetName}'. Available agents: ${runtimeKeys.join(', ')}`
      );
    }
    return { region: options.region ?? targetConfig.region, runtimeArn: agentState.runtimeArn };
  }

  // No --runtime: error if ambiguous, auto-select if only one agent deployed
  if (runtimeKeys.length > 1) {
    throw new Error(
      `Multiple agents deployed in target '${targetName}'. Specify one with --runtime <name>: ${runtimeKeys.join(', ')}`
    );
  }

  const agentState = targetState?.resources?.runtimes?.[runtimeKeys[0]!];
  if (!agentState?.runtimeArn) {
    throw new Error('Could not determine runtime ARN from deployed state.');
  }

  return {
    region: options.region ?? targetConfig.region,
    runtimeArn: agentState.runtimeArn,
  };
}

// ---------------------------------------------------------------------------
// One-shot exec
// ---------------------------------------------------------------------------

/** Execute a single command in the runtime container (non-interactive). */
export async function handleExecOneShot(ctx: ExecContext, options: ExecOptions): Promise<ExecResult> {
  const command = options.command?.join(' ');
  if (!command) {
    return { success: false, error: new Error('No command provided for one-shot exec.') };
  }

  let stdoutBuf = '';
  let stderrBuf = '';

  // timeout === 0 means no timeout (treat as unset)
  const timeoutSec = options.timeout !== undefined && options.timeout > 0 ? options.timeout : undefined;

  let exitCode: number | undefined;
  try {
    const invokeOptions: Parameters<typeof executeBashCommand>[0] = {
      region: ctx.region,
      runtimeArn: ctx.runtimeArn,
      command,
      sessionId: options.sessionId,
      timeout: timeoutSec,
    };

    const result = await executeBashCommand(invokeOptions);

    // Enforce client-side wall-clock timeout by racing the timeout against each
    // iterator next() call — this fires even when the stream is blocked with no events.
    const TIMEOUT_SENTINEL = Symbol('timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise =
      timeoutSec !== undefined
        ? new Promise<typeof TIMEOUT_SENTINEL>(resolve => {
            timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutSec * 1000);
          })
        : null;

    const iter = result.stream[Symbol.asyncIterator]();
    while (true) {
      const nextPromise = iter.next().then(r => r);
      const winner = timeoutPromise ? await Promise.race([nextPromise, timeoutPromise]) : await nextPromise;

      if (winner === TIMEOUT_SENTINEL) {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        void iter.return?.(); // signal cleanup; don't await — underlying stream may still be open
        return {
          success: false,
          error: new Error(`Command timed out after ${timeoutSec}s`),
          sessionId: options.sessionId,
        };
      }

      const { done, value: event } = winner as Awaited<ReturnType<typeof iter.next>>;
      if (done) break;

      if (event.type === 'stdout' && event.data) {
        stdoutBuf += event.data;
        if (!options.json) process.stdout.write(event.data);
      } else if (event.type === 'stderr' && event.data) {
        stderrBuf += event.data;
        if (!options.json) process.stderr.write(event.data);
      } else if (event.type === 'stop') {
        exitCode = event.exitCode;
        // Detect server-side timeout: server sets status='TIMED_OUT' or kills with exitCode -1.
        // Both paths need the friendly message; exitCode -1 without a timeout set means a real crash.
        if (event.status === 'TIMED_OUT' || (exitCode === -1 && timeoutSec !== undefined)) {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          void iter.return?.();
          return {
            success: false,
            error: new Error(`Command timed out after ${timeoutSec}s`),
            sessionId: options.sessionId,
          };
        }
      }
    }

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (exitCode === undefined) {
    return { success: false, error: new Error('Command stream ended without exit code') };
  }

  if (exitCode !== 0) {
    return {
      success: false,
      error: new Error(`Command exited with code ${exitCode}`),
      exitCode,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      sessionId: options.sessionId,
    };
  }

  return { success: true, exitCode, stdout: stdoutBuf, stderr: stderrBuf, sessionId: options.sessionId };
}

// ---------------------------------------------------------------------------
// Interactive PTY session
// ---------------------------------------------------------------------------

/** Open an interactive PTY shell session against a running runtime container. */
export async function handleShellSession(ctx: ExecContext, options: ExecOptions): Promise<ExecResult> {
  // Auto-generate a sessionId so the user can reconnect to the same VM after detaching.
  // If the user passed --session-id explicitly, use that (reconnect scenario).
  const sessionId = options.sessionId ?? randomUUID();

  process.stderr.write('Connecting to agent VM...\n');

  // Declare before the try block so closures passed to connectShell can assign them
  // without hitting a temporal dead zone (TDZ) error if reconnect kicks in during connect.
  let reconnectAttempts = 0;
  let wasKicked = false;

  let conn;
  try {
    const extraHeaders: Record<string, string> = {};
    if (options.baggage) {
      extraHeaders.baggage = options.baggage;
    }

    conn = await connectShell({
      region: ctx.region,
      runtimeArn: ctx.runtimeArn,
      sessionId,
      shellId: options.shellId,
      bearerToken: options.bearerToken,
      headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      reconnect: {
        onAttempt: (attempt, reason) => {
          reconnectAttempts = attempt;
          process.stderr.write(`\r\n[disconnected · ${reason} · reconnecting (${attempt}/5)...]\r\n`);
        },
        onKicked: () => {
          wasKicked = true;
          process.stderr.write('\r\n[session attached from another client · not reconnecting]\r\n');
        },
        onNewSession: () => {
          process.stderr.write('\r\n[new shell session (previous session expired)]\r\n');
        },
        onBytesDropped: n => {
          process.stderr.write(`\r\n[${n} bytes of output lost during disconnect]\r\n`);
        },
      },
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  const framer = new ShellFramer();
  const { ws, shellId, reconnected } = conn;
  let exitCode: number | null = null;

  // Warn when the user requested a reconnect but the previous shell had already exited
  if (options.shellId && !reconnected) {
    process.stderr.write(
      '[info] Previous shell session has ended. Starting a new shell (environment variables and history are not restored).\n'
    );
  }

  process.stderr.write(`[connected · session ${sessionId} · Ctrl+D or 'exit' to quit · Ctrl+] to detach]\n`);

  return new Promise<ExecResult>(resolve => {
    // Enter raw mode so keystrokes are forwarded byte-for-byte
    const wasRaw = (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    let detached = false;

    // Start RFC 6455 keepalive: Ping every 30s, reconnect if Pong silent for 60s
    const stopKeepalive = startKeepalive(ws, () => {
      if (ws.readyState === ws.OPEN) ws.terminate();
    });

    // Forward terminal resize → shell — defined here so cleanup can deregister only this listener
    const sendResize = () => {
      if (ws.readyState === ws.OPEN) {
        const cols = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        ws.send(framer.encodeResize(cols, rows));
      }
    };

    const cleanup = (code: number | null) => {
      stopKeepalive();

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.off('SIGWINCH', sendResize);

      // Print reconnect hint on detach (Ctrl+]) or network drop (no exit code).
      // Not on clean shell exit — the shell process terminated and there is nothing to reconnect to.
      if (shellId && (detached || code === null)) {
        if (!detached) {
          process.stderr.write('\n[disconnected]\n');
        }
        process.stderr.write(
          `[to reconnect:]\n` +
            `  agentcore exec --it \\\n` +
            `    --runtime ${ctx.runtimeArn} \\\n` +
            `    --region ${ctx.region} \\\n` +
            `    --session-id ${sessionId} \\\n` +
            `    --shell-id ${shellId}\n`
        );
      }

      if (code !== null && !detached) {
        process.stderr.write(`\n[session closed · exit ${code}]\n`);
      }

      const sessionMeta = {
        sessionId,
        shellId,
        exitCode: code,
        reconnectAttempts,
        wasKicked,
        isReconnect: reconnected,
        detached,
      };

      // null = server closed WS without STATUS frame (treat as clean); signal exits (>=128) are also normal
      if (code === 0 || code === null || (code !== null && code >= 128)) {
        resolve({ success: true, ...sessionMeta });
      } else {
        resolve({
          success: false,
          error: new Error(`Shell exited with code ${code}`),
          ...sessionMeta,
        });
      }
    };

    // Forward stdin → shell; Ctrl+] (0x1d) detaches without killing the remote shell
    process.stdin.on('data', (chunk: Buffer | string) => {
      // Ink may leave stdin encoding as 'utf8', causing data events to emit strings.
      // Normalize to Buffer before any byte-level inspection or framing.
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary');
      if (buf.length === 1 && buf[0] === 0x1d) {
        detached = true;
        process.stderr.write('\n[detached]\n');
        ws.close();
        return;
      }
      if (ws.readyState === ws.OPEN) {
        ws.send(framer.encodeStdinRaw(buf));
      }
    });

    process.on('SIGWINCH', sendResize);
    // Send initial size
    sendResize();

    // Receive frames from shell
    ws.on('message', (data: WebSocket.RawData) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      let frame;
      try {
        frame = framer.decode(raw);
      } catch {
        return;
      }

      switch (frame.channel) {
        case ShellChannel.STDOUT:
          process.stdout.write(frame.payload);
          break;
        case ShellChannel.STDERR:
          process.stderr.write(frame.payload);
          break;
        case ShellChannel.STATUS: {
          const parsed = parseStatusFrame(frame);
          if (parsed.type === 'termination') {
            exitCode = parsed.exitCode;
            ws.close();
          }
          break;
        }
        case ShellChannel.CLOSE:
          ws.close();
          break;
        default:
          break;
      }
    });

    ws.on('close', (code: number) => {
      // If the STATUS termination frame arrived, use its exit code.
      // Otherwise, treat non-kick closes as exit 0: the shell ran to completion but the server
      // didn't send a STATUS termination frame (observed behavior on the beta runtime).
      // connectShell only resolves after the STATUS confirmation frame, so the session is always
      // active by the time we reach here — there are no unconfirmed closes.
      const resolvedExitCode = exitCode ?? (code !== 4000 ? 0 : null);
      cleanup(resolvedExitCode);
    });

    ws.on('error', (err: Error) => {
      process.stderr.write(`\n[shell error: ${err.message}]\n`);
      cleanup(exitCode ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Interactive shell with telemetry
// ---------------------------------------------------------------------------

export async function runInteractiveShell(options: ExecOptions): Promise<void> {
  const sessionResult = await withCommandRunTelemetry(
    'exec',
    {
      interactive: true,
      has_runtime: Boolean(options.runtimeArn),
      has_shell_id: Boolean(options.shellId),
      has_session_id: Boolean(options.sessionId),
      is_one_shot: false,
      auth_type: options.bearerToken ? 'bearer_token' : 'sigv4',
      is_reconnect: false,
      exit_code: 1,
      reconnect_attempts: 0,
      was_kicked: false,
    },
    async recorder => {
      const ctx = await loadExecContext(options);
      const r = await handleShellSession(ctx, options);
      recorder.set({
        is_reconnect: r.isReconnect ?? Boolean(options.shellId),
        exit_code: r.exitCode ?? (r.success ? 0 : 1),
        reconnect_attempts: r.reconnectAttempts ?? 0,
        was_kicked: r.wasKicked ?? false,
      });
      return r;
    }
  );

  if (!sessionResult.success) {
    throw sessionResult.error;
  }
}
