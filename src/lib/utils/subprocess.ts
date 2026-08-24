import { isWindows } from './platform';
import { spawn, spawnSync } from 'child_process';
import type { StdioOptions } from 'child_process';

/**
 * Subprocess utilities for AgentCore.
 *
 * IMPORTANT: Async functions (runSubprocess, checkSubprocess, runSubprocessCapture)
 * are safe for TUI contexts and are exported from lib.
 *
 * Sync functions (runSubprocessCaptureSync, checkSubprocessSync) block the event loop
 * and are ONLY safe in CDK bundling contexts (which run in a subprocess). They are
 * intentionally NOT exported from the public API to prevent accidental UI freezes.
 */

export interface SubprocessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  shell?: boolean;
}

/**
 * When shell mode is enabled, merge args into the command string so that
 * Node.js does not receive both a non-empty args array and `shell: true`.
 * Passing both triggers DEP0190 on Node ≥ 22 (and a warning on earlier
 * versions) because the arguments are concatenated without escaping.
 */
function resolveCommand(command: string, args: string[], useShell: boolean): { cmd: string; cmdArgs: string[] } {
  if (useShell) {
    return { cmd: [command, ...args].join(' '), cmdArgs: [] };
  }
  return { cmd: command, cmdArgs: args };
}

export async function runSubprocess(command: string, args: string[], options: SubprocessOptions = {}): Promise<void> {
  const shell = options.shell ?? isWindows;
  const { cmd, cmdArgs } = resolveCommand(command, args, shell);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'inherit',
      shell,
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = code !== null ? `code ${code}` : `signal ${String(signal)}`;
      reject(new Error(`${command} exited with ${reason}`));
    });
  });
}

export async function checkSubprocess(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): Promise<boolean> {
  const shell = options.shell ?? isWindows;
  const { cmd, cmdArgs } = resolveCommand(command, args, shell);
  return new Promise(resolve => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'ignore',
      shell,
    });

    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export async function runSubprocessCapture(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): Promise<SubprocessResult> {
  const shell = options.shell ?? isWindows;
  const { cmd, cmdArgs } = resolveCommand(command, args, shell);
  return new Promise(resolve => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
      shell,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: unknown) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    });

    child.stderr?.on('data', (chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    });

    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    child.on('error', error => {
      resolve({ stdout, stderr: stderr || error.message, code: -1, signal: null });
    });
  });
}

export function runSubprocessCaptureSync(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): SubprocessResult {
  const shell = options.shell ?? isWindows;
  const { cmd, cmdArgs } = resolveCommand(command, args, shell);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
    shell,
    encoding: 'utf-8',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status,
    signal: result.signal,
  };
}

export function checkSubprocessSync(command: string, args: string[], options: SubprocessOptions = {}): boolean {
  const shell = options.shell ?? isWindows;
  const { cmd, cmdArgs } = resolveCommand(command, args, shell);
  try {
    const result = spawnSync(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'ignore',
      shell,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
