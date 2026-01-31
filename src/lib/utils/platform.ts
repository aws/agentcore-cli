import { join } from 'node:path';

/**
 * Platform detection utilities and cross-platform path helpers.
 * 
 * This module provides utilities to handle platform-specific differences
 * between Windows and Unix-like systems (Linux, macOS).
 * 
 * Key differences handled:
 * - Python venv structure: bin/ (Unix) vs Scripts/ (Windows)
 * - Executable extensions: none (Unix) vs .exe, .cmd, .bat (Windows)
 * - Shell commands: sh/bash (Unix) vs cmd/powershell (Windows)
 */

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Get the path to an executable in a Python virtual environment.
 * 
 * Python virtual environments have different structures on different platforms:
 * - Unix (Linux/macOS): .venv/bin/python, .venv/bin/uvicorn
 * - Windows: .venv\Scripts\python.exe, .venv\Scripts\uvicorn.exe
 * 
 * @param venvPath - Path to the virtual environment directory (e.g., '.venv')
 * @param executable - Name of the executable without extension (e.g., 'python', 'uvicorn')
 * @returns Full path to the executable with correct directory and extension
 * 
 * @example
 * ```ts
 * // On Unix: /path/to/project/.venv/bin/uvicorn
 * // On Windows: C:\path\to\project\.venv\Scripts\uvicorn.exe
 * const uvicornPath = getVenvExecutable('.venv', 'uvicorn');
 * ```
 */
export function getVenvExecutable(venvPath: string, executable: string): string {
  const binDir = isWindows ? 'Scripts' : 'bin';
  const ext = isWindows ? '.exe' : '';
  return join(venvPath, binDir, executable + ext);
}

/**
 * Get the appropriate shell command for the current platform.
 * 
 * @returns The default shell command ('cmd' on Windows, 'sh' on Unix)
 */
export function getShellCommand(): string {
  return isWindows ? 'cmd' : (process.env.SHELL ?? '/bin/sh');
}

/**
 * Get the appropriate shell arguments for executing a command.
 * 
 * @param command - The command to execute
 * @returns Array of arguments to pass to the shell
 * 
 * @example
 * ```ts
 * // On Unix: ['-c', 'echo hello']
 * // On Windows: ['/c', 'echo hello']
 * const args = getShellArgs('echo hello');
 * spawn(getShellCommand(), args);
 * ```
 */
export function getShellArgs(command: string): string[] {
  return isWindows ? ['/c', command] : ['-c', command];
}

/**
 * Normalize a command for cross-platform execution.
 * Adds .exe extension on Windows if needed.
 * 
 * @param command - The command name
 * @returns The command with appropriate extension
 */
export function normalizeCommand(command: string): string {
  if (isWindows && !command.endsWith('.exe') && !command.endsWith('.cmd') && !command.endsWith('.bat')) {
    // Check if it's a known command that needs .exe
    const exeCommands = ['python', 'node', 'npm', 'git', 'uvicorn', 'pip'];
    if (exeCommands.some(cmd => command.endsWith(cmd))) {
      return command + '.exe';
    }
  }
  return command;
}
