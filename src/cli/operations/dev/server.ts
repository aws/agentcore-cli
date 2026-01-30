import { type ChildProcess, spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';

export type LogLevel = 'info' | 'warn' | 'error' | 'system';

export interface DevServerCallbacks {
  onLog: (level: LogLevel, message: string) => void;
  onExit: (code: number | null) => void;
}

export function findAvailablePort(startPort: number): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => resolve(startPort));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

function convertEntrypointToModule(entrypoint: string): string {
  if (entrypoint.includes(':')) return entrypoint;
  const path = entrypoint.replace(/\.py$/, '').replace(/\//g, '.');
  return `${path}:app`;
}

/**
 * Ensures a Python virtual environment exists and has dependencies installed.
 * Creates the venv and runs uv sync if .venv doesn't exist.
 * Returns true if successful, false otherwise.
 */
function ensurePythonVenv(cwd: string, onLog: (level: LogLevel, message: string) => void): boolean {
  const venvPath = join(cwd, '.venv');
  const uvicornPath = join(venvPath, 'bin', 'uvicorn');

  // Check if venv and uvicorn already exist
  if (existsSync(uvicornPath)) {
    return true;
  }

  onLog('system', 'Setting up Python environment...');

  // Create venv if it doesn't exist
  if (!existsSync(venvPath)) {
    onLog('info', 'Creating virtual environment...');
    const venvResult = spawnSync('uv', ['venv'], { cwd, stdio: 'pipe' });
    if (venvResult.status !== 0) {
      onLog('error', `Failed to create venv: ${venvResult.stderr?.toString() || 'unknown error'}`);
      return false;
    }
  }

  // Install dependencies using uv sync (reads from pyproject.toml)
  onLog('info', 'Installing dependencies...');
  const syncResult = spawnSync('uv', ['sync'], { cwd, stdio: 'pipe' });
  if (syncResult.status !== 0) {
    // Fallback: try installing uvicorn directly if uv sync fails
    onLog('warn', 'uv sync failed, trying direct uvicorn install...');
    const pipResult = spawnSync('uv', ['pip', 'install', 'uvicorn'], { cwd, stdio: 'pipe' });
    if (pipResult.status !== 0) {
      onLog('error', `Failed to install dependencies: ${pipResult.stderr?.toString() || 'unknown error'}`);
      return false;
    }
  }

  onLog('system', 'Python environment ready');
  return true;
}

export interface SpawnDevServerOptions {
  module: string;
  cwd: string;
  port: number;
  isPython: boolean;
  callbacks: DevServerCallbacks;
  /** Additional environment variables to pass to the spawned process */
  envVars?: Record<string, string>;
}

export function spawnDevServer(options: SpawnDevServerOptions): ChildProcess | null {
  const { module, cwd, port, isPython, callbacks, envVars = {} } = options;
  const { onLog, onExit } = callbacks;

  // For Python, ensure venv exists before starting
  if (isPython && !ensurePythonVenv(cwd, onLog)) {
    onExit(1);
    return null;
  }

  // For Python, use the venv's uvicorn directly to avoid PATH issues
  const cmd = isPython ? join(cwd, '.venv', 'bin', 'uvicorn') : 'npx';
  const args = isPython
    ? [convertEntrypointToModule(module), '--reload', '--host', '127.0.0.1', '--port', String(port)]
    : ['tsx', 'watch', (module.split(':')[0] ?? module).replace(/\./g, '/') + '.ts'];

  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...envVars, PORT: String(port), LOCAL_DEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    const output = data.toString().trim();
    if (!output) return;
    for (const line of output.split('\n')) {
      if (line) onLog('info', line);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const output = data.toString().trim();
    if (!output) return;
    for (const line of output.split('\n')) {
      if (!line) continue;
      if (line.includes('WARNING')) onLog('warn', line);
      else if (line.includes('ERROR') || line.includes('error')) onLog('error', line);
      else onLog('info', line);
    }
  });

  child.on('error', err => {
    onLog('error', `Failed to start: ${err.message}`);
    onExit(1);
  });

  child.on('exit', code => onExit(code));

  return child;
}

export function killServer(child: ChildProcess | null): void {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 2000);
}
