import { ConfigIO } from '../../../lib';
import { executeBashCommand } from '../../aws/agentcore';
import { regionFromArn } from '../../aws/arn';
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

/** True when `arn` is a harness ARN (…:harness/…) rather than a runtime ARN (…:runtime/…). */
function isHarnessArn(arn: string): boolean {
  return arn.includes(':harness/');
}

/** Guard interactive (`--it`) exec against harness targets.
 *  The data plane (InvokeAgentRuntimeCommandShell) explicitly rejects harness-linked runtimes:
 *  interactive shell is not supported for harnesses yet. One-shot exec IS supported (routes through
 *  the harness ExecuteCommand path), so fail fast here with actionable guidance instead of letting
 *  the WebSocket connection surface an opaque service error. */
function assertInteractiveHarnessUnsupported(options: ExecOptions, ctx: ExecContext): ExecContext {
  if (options.interactive && isHarnessArn(ctx.runtimeArn)) {
    throw new Error(
      'Interactive shell (--it) is not supported for harness deployments yet. ' +
        'Use one-shot exec instead, e.g. `agentcore exec "<command>"`.'
    );
  }
  return ctx;
}

/** Resolve region + runtimeArn from options and/or agentcore.json deployed state.
 *  --runtime accepts either a full ARN (arn:...) or an agent name from deployed state.
 *  A full ARN resolves with no project and no config on disk; only a *name* needs deployed state.
 */
export async function loadExecContext(options: ExecOptions, configIO: ConfigIO = new ConfigIO()): Promise<ExecContext> {
  // Mutual exclusion: --runtime and --harness cannot both be set. Checked first so it applies to
  // every path below, including the ARN short-circuits (where --runtime is a full ARN, not a name).
  if (options.runtimeArn && options.harnessName) {
    throw new Error('Cannot specify both --runtime and --harness.');
  }

  // Short-circuit: an explicit ARN already carries its region in field 3, so --region is optional.
  // Reading config here would demand a project, an aws-targets.json and a completed deploy purely to
  // recover a value the caller already supplied — which blocks `exec` for anyone who deploys their
  // runtimes outside this CLI (CDK, pipelines, personal stacks).
  // A region-less/malformed ARN still falls through so config can supply the region.
  if (options.runtimeArn?.startsWith('arn:')) {
    const region = options.region ?? regionFromArn(options.runtimeArn);
    if (region) {
      return assertInteractiveHarnessUnsupported(options, { region, runtimeArn: options.runtimeArn });
    }
  }

  // Same short-circuit for --harness <arn>. Validate it's a harness ARN (not a runtime ARN).
  if (options.harnessName?.startsWith('arn:')) {
    if (!isHarnessArn(options.harnessName)) {
      throw new Error(
        `--harness expects a harness ARN (…:harness/…), got '${options.harnessName}'. Use --runtime for a runtime ARN.`
      );
    }
    const region = options.region ?? regionFromArn(options.harnessName);
    if (region) {
      return assertInteractiveHarnessUnsupported(options, { region, runtimeArn: options.harnessName });
    }
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
  const harnessKeys = Object.keys(targetState?.resources?.harnesses ?? {});

  // --runtime <arn> whose region field is empty or malformed: only reachable when the short-circuit
  // above could not derive a region, so config is the last resort.
  if (options.runtimeArn?.startsWith('arn:')) {
    return assertInteractiveHarnessUnsupported(options, {
      region: options.region ?? targetConfig.region,
      runtimeArn: options.runtimeArn,
    });
  }

  // --harness <name|arn>: resolve to the harness ARN.
  // exec must target the harness ARN, NOT the underlying agentRuntimeArn: the data plane blocks
  // ExecuteCommand / shell against a harness-linked runtime ARN, but routes a harness ARN on the
  // /runtimes/{arn}/... path through the harness exec path (delegates to LoopyDP).
  if (options.harnessName) {
    // A full ARN is used directly (must be a harness ARN, not a runtime ARN); a name is looked up.
    if (options.harnessName.startsWith('arn:')) {
      if (!isHarnessArn(options.harnessName)) {
        throw new Error(
          `--harness expects a harness ARN (…:harness/…), got '${options.harnessName}'. Use --runtime for a runtime ARN.`
        );
      }
      return assertInteractiveHarnessUnsupported(options, {
        region: options.region ?? targetConfig.region,
        runtimeArn: options.harnessName,
      });
    }

    const harnessState = targetState?.resources?.harnesses?.[options.harnessName];
    if (!harnessState) {
      throw new Error(
        `Harness '${options.harnessName}' not found in target '${targetName}'. Available harnesses: ${harnessKeys.join(', ')}`
      );
    }
    return assertInteractiveHarnessUnsupported(options, {
      region: options.region ?? targetConfig.region,
      runtimeArn: harnessState.harnessArn,
    });
  }

  // --runtime <name>: look up by agent name in deployed state
  if (options.runtimeArn) {
    const agentState = targetState?.resources?.runtimes?.[options.runtimeArn];
    if (!agentState?.runtimeArn) {
      throw new Error(
        `Agent '${options.runtimeArn}' not found in target '${targetName}'. Available agents: ${runtimeKeys.join(', ')}`
      );
    }
    return assertInteractiveHarnessUnsupported(options, {
      region: options.region ?? targetConfig.region,
      runtimeArn: agentState.runtimeArn,
    });
  }

  // No flag: exec needs exactly one target. Both buckets collapse to a single candidate list —
  // exec only ever wants one ARN, so the count is what matters, not the kind. Harnesses resolve to
  // their harness ARN (not agentRuntimeArn — see the --harness branch above for why).
  const candidates = [
    ...Object.values(targetState?.resources?.runtimes ?? {}).map(r => r.runtimeArn),
    ...Object.values(targetState?.resources?.harnesses ?? {}).map(h => h.harnessArn),
  ].filter(Boolean);

  if (candidates.length === 0) {
    throw new Error(`No deployed runtimes or harnesses found in target '${targetName}'.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Target '${targetName}' has multiple deploy targets. Specify one with --runtime <name> or --harness <name>: ` +
        [...runtimeKeys, ...harnessKeys].join(', ')
    );
  }

  return assertInteractiveHarnessUnsupported(options, {
    region: options.region ?? targetConfig.region,
    runtimeArn: candidates[0]!,
  });
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
      },
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  const framer = new ShellFramer();
  const { ws, shellId } = conn;
  let exitCode: number | null = null;

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
          // Confirmation frames silently swallowed — server may still send them during transition
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
      // The STATUS termination frame is the authoritative exit signal — when it arrived, use its
      // exit code regardless of the WebSocket close code.
      //
      // Without a STATUS frame, fall back to the WebSocket close code. connectShell now resolves as
      // soon as the socket opens (the 0x03 confirmation-frame wait was removed), so an abnormal
      // close such as 1006 can occur before the shell is usable. Only code 1000 (normal closure —
      // the server's deliberate close after a clean shell exit) counts as success; any other code
      // is a real failure and must not be reported as exit 0. Kick (4000) stays null so cleanup
      // prints the reconnect hint instead of a spurious exit line.
      let resolvedExitCode: number | null;
      if (exitCode !== null) {
        resolvedExitCode = exitCode;
      } else if (code === 1000) {
        resolvedExitCode = 0;
      } else if (code === 4000) {
        resolvedExitCode = null;
      } else {
        resolvedExitCode = 1;
      }
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
      has_harness: Boolean(options.harnessName),
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
        is_reconnect: Boolean(options.shellId),
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
