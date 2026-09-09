import type { StdioOptions } from 'child_process';
import crossSpawn from 'cross-spawn';

/**
 * Subprocess utilities for AgentCore.
 *
 * IMPORTANT: Async functions (runSubprocess, checkSubprocess, runSubprocessCapture)
 * are safe for TUI contexts and are exported from lib.
 *
 * Sync functions (runSubprocessCaptureSync, checkSubprocessSync) block the event loop
 * and are ONLY safe in CDK bundling contexts (which run in a subprocess). They are
 * intentionally NOT exported from the public API to prevent accidental UI freezes.
 *
 * Nothing spawns through a shell. cross-spawn resolves Windows .cmd/.bat wrappers and
 * escapes arguments so a metacharacter in an argument (an `&` in a path, say) reaches
 * the child intact instead of being interpreted by cmd.exe.
 */

export interface SubprocessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

export async function runSubprocess(command: string, args: string[], options: SubprocessOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { ...options, stdio: options.stdio ?? 'inherit' });

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
  return new Promise(resolve => {
    const child = crossSpawn(command, args, { ...options, stdio: options.stdio ?? 'ignore' });

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
  return new Promise(resolve => {
    const child = crossSpawn(command, args, { ...options, stdio: 'pipe' });

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
  const result = crossSpawn.sync(command, args, { ...options, stdio: 'pipe', encoding: 'utf-8' });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status,
    signal: result.signal,
  };
}

export function checkSubprocessSync(command: string, args: string[], options: SubprocessOptions = {}): boolean {
  try {
    const result = crossSpawn.sync(command, args, { ...options, stdio: options.stdio ?? 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}
