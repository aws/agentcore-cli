/**
 * Persistent Shell - Fast alias-capable execution path
 *
 * Uses 'script' command to allocate a PTY for proper output buffering.
 * Without a PTY, falls back to one-shot command execution.
 *
 * Constraints:
 * - Single command at a time (concurrent calls throw)
 * - Ctrl-C kills shell entirely (next command re-warms)
 */
import { spawnShellCommand } from './executor';
import type { ShellExecutor, ShellExecutorCallbacks } from './types';
import { ChildProcess, spawn } from 'node:child_process';

const MARKER = `__AGENTCORE_DONE_${process.pid}_${Date.now()}__`;

/** Default timeout for shell commands (5 minutes) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Extract environment exports from a command and mirror them to process.env.
 * This allows env vars set in shell mode to be picked up by Node.
 *
 * Handles concatenated exports like: export FOO=xxxexport BAR=yyy
 * (where exports run together without separators from pasting)
 */
function syncExports(cmd: string): void {
  // Pre-process: insert newlines before 'export' keywords to handle concatenated pastes
  const normalizedCmd = cmd.replace(/export\s+([A-Z_])/g, '\nexport $1');

  // Match export statements - handle both quoted and unquoted values
  // Supports: export KEY=value, export KEY="value", export KEY='value'
  const regex = /export\s+([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s\n;]+))/gi;
  let match;
  while ((match = regex.exec(normalizedCmd)) !== null) {
    const key = match[1];
    // Value is in group 2 (double quoted), 3 (single quoted), or 4 (unquoted)
    const value = match[2] ?? match[3] ?? match[4];
    if (key && value) {
      process.env[key] = value;
    }
  }
}

let shell: ChildProcess | null = null;
let buffer = '';
let activeCallback: ShellExecutorCallbacks | null = null;
let busy = false;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
// PTY via 'script' command is not available on Windows
let ptyAvailable = process.platform !== 'win32';

// Pending command info for retry on PTY failure
let pendingCommand: { cmd: string; callbacks: ShellExecutorCallbacks; timeoutMs: number } | null = null;

function onData(data: Buffer) {
  const text = data.toString();
  buffer += text;

  // Detect PTY failure - this error means script command isn't working
  if (text.includes('tcgetattr') || text.includes('ioctl') || text.includes('not supported on socket')) {
    ptyAvailable = false;

    // If we have a pending command, retry it with one-shot mode
    if (busy && pendingCommand) {
      const { cmd, callbacks, timeoutMs } = pendingCommand;
      pendingCommand = null;

      // Clean up the failed persistent shell
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      shell?.kill();
      shell = null;
      busy = false;
      activeCallback = null;
      buffer = '';

      // Retry with one-shot execution (don't call callbacks.onComplete yet)
      // Note: executor is intentionally unused here - the callbacks handle completion
      spawnOneShotCommand(cmd, callbacks, timeoutMs);
    }
    return;
  }

  if (!busy || !activeCallback) return;

  // Check for completion marker first
  const markerIdx = buffer.indexOf(MARKER);
  if (markerIdx >= 0) {
    // Extract any output before the marker
    const out = buffer.slice(0, markerIdx);
    const rest = buffer.slice(markerIdx + MARKER.length);
    const code = parseInt(/^(\d+)/.exec(rest)?.[0] ?? '0', 10);
    buffer = '';
    busy = false;
    pendingCommand = null;

    // Clear timeout
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    // Emit any remaining output
    const lines = out.split(/\r?\n/).filter(Boolean);
    if (lines.length) activeCallback.onOutput(lines);
    activeCallback.onComplete(code);
    activeCallback = null;
    return;
  }

  // Stream output incrementally: emit complete lines as they arrive
  // Keep incomplete lines (without trailing newline) in buffer
  const lastNewline = buffer.lastIndexOf('\n');
  if (lastNewline >= 0) {
    const completeData = buffer.slice(0, lastNewline);
    buffer = buffer.slice(lastNewline + 1);

    const lines = completeData.split(/\r?\n/).filter(Boolean);
    if (lines.length) {
      activeCallback.onOutput(lines);
    }
  }
}

function ensureShell(): ChildProcess {
  if (shell && !shell.killed) return shell;

  // PTY is not available on Windows - this should never be called on Windows
  // but if it is, throw a clear error
  if (!ptyAvailable) {
    throw new Error('PTY not available on this platform - use one-shot execution instead');
  }

  const sh = process.env.SHELL ?? '/bin/sh';
  const home = process.env.HOME ?? '';

  // Use 'script' to allocate a PTY, which forces line-buffered output.
  // On macOS: script -q /dev/null <shell>
  // On Linux: script -q /dev/null -c <shell>
  const platform = process.platform;
  const scriptArgs = platform === 'darwin' ? ['-q', '/dev/null', sh] : ['-q', '/dev/null', '-c', sh];

  shell = spawn('script', scriptArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PS1: '', PS2: '', TERM: 'dumb' },
  });

  shell.stdout?.on('data', onData);
  shell.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString();
    // Detect PTY failures
    if (msg.includes('tcgetattr') || msg.includes('ioctl') || msg.includes('not supported')) {
      ptyAvailable = false;
    }
    onData(data);
  });
  shell.on('close', () => {
    shell = null;
  });

  // Source config (output goes to buffer, will be cleared on first command)
  const rc = sh.includes('zsh')
    ? `source "${home}/.zshrc" 2>/dev/null`
    : sh.includes('bash')
      ? `[ -f ~/.bashrc ] && . ~/.bashrc; shopt -s expand_aliases`
      : '';

  if (rc) {
    shell.stdin?.write(`${rc}\n`);
  }

  return shell;
}

/** Call on app start to pre-warm shell during idle time */
export function warmup(): void {
  // Skip warmup on Windows where PTY is not available
  if (!ptyAvailable) {
    return;
  }
  // Try to spawn the shell - if PTY fails, ptyAvailable will be set to false
  // within the first few hundred ms via the stderr handler
  ensureShell();
}

export interface PersistentShellOptions {
  /** Timeout in milliseconds. Default: 5 minutes. Set to 0 to disable. */
  timeoutMs?: number;
}

/** Execute command in persistent shell. Falls back to one-shot if PTY unavailable. */
export function spawnPersistentShellCommand(
  cmd: string,
  callbacks: ShellExecutorCallbacks,
  options?: PersistentShellOptions
): ShellExecutor {
  if (busy) {
    throw new Error('Shell busy: concurrent commands not supported');
  }

  // Sync exports to process.env regardless of execution mode
  syncExports(cmd);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // If PTY is known to be unavailable, use one-shot execution
  if (!ptyAvailable) {
    return spawnOneShotCommand(cmd, callbacks, timeoutMs);
  }

  // Try persistent shell with PTY
  const s = ensureShell();

  // Check if PTY failed during shell creation (detected via stderr)
  if (!ptyAvailable) {
    shell?.kill();
    shell = null;
    return spawnOneShotCommand(cmd, callbacks, timeoutMs);
  }

  busy = true;
  activeCallback = callbacks;
  buffer = '';
  pendingCommand = { cmd, callbacks, timeoutMs };
  s.stdin?.write(`${cmd}; echo "${MARKER}$?"\n`);

  // Set up timeout if enabled
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (busy && activeCallback) {
        const minutes = Math.floor(timeoutMs / 60000);
        callbacks.onError(`Command timed out after ${minutes} minute${minutes !== 1 ? 's' : ''}`);
        shell?.kill();
        shell = null;
        busy = false;
        activeCallback = null;
        timeoutHandle = null;
        callbacks.onComplete(124); // 124 is standard timeout exit code
      }
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    shell?.kill();
    shell = null;
    busy = false;
    activeCallback = null;
    pendingCommand = null;
  };

  return {
    child: s,
    kill: () => {
      cleanup();
      callbacks.onComplete(130); // 130 is SIGINT exit code
    },
  };
}

/** One-shot command execution - spawns a new shell for each command */
function spawnOneShotCommand(cmd: string, callbacks: ShellExecutorCallbacks, timeoutMs: number): ShellExecutor {
  let localTimeout: ReturnType<typeof setTimeout> | null = null;

  const executor = spawnShellCommand(cmd, {
    onOutput: callbacks.onOutput,
    onComplete: code => {
      if (localTimeout) {
        clearTimeout(localTimeout);
        localTimeout = null;
      }
      callbacks.onComplete(code);
    },
    onError: callbacks.onError,
  });

  // Set up timeout
  if (timeoutMs > 0) {
    localTimeout = setTimeout(() => {
      const minutes = Math.floor(timeoutMs / 60000);
      callbacks.onError(`Command timed out after ${minutes} minute${minutes !== 1 ? 's' : ''}`);
      executor.kill();
      callbacks.onComplete(124);
    }, timeoutMs);
  }

  return executor;
}

/** Destroy shell (cleanup on app exit) */
export function destroyShell(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  shell?.kill();
  shell = null;
  busy = false;
  activeCallback = null;
  pendingCommand = null;
}
