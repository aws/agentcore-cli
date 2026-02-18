import { getVenvExecutable } from '../../../lib/utils/platform';
import { DevServer, type LogLevel, type SpawnConfig } from './dev-server';
import { convertEntrypointToModule } from './utils';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Ensures a Python virtual environment exists and has dependencies installed.
 * Creates the venv and runs uv sync if .venv doesn't exist.
 * Returns true if successful, false otherwise.
 */
function ensurePythonVenv(cwd: string, onLog: (level: LogLevel, message: string) => void): boolean {
  const venvPath = join(cwd, '.venv');
  const uvicornPath = getVenvExecutable(venvPath, 'uvicorn');

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

/** Dev server for CodeZip agents. Runs uvicorn (Python) or npx tsx (Node.js) locally. */
export class CodeZipDevServer extends DevServer {
  protected prepare(): Promise<boolean> {
    return Promise.resolve(
      this.config.isPython ? ensurePythonVenv(this.config.directory, this.options.callbacks.onLog) : true
    );
  }

  protected getSpawnConfig(): SpawnConfig {
    const { module, directory, isPython } = this.config;
    const { port, envVars = {} } = this.options;

    const cmd = isPython ? getVenvExecutable(join(directory, '.venv'), 'uvicorn') : 'npx';
    const args = isPython
      ? [convertEntrypointToModule(module), '--reload', '--host', '127.0.0.1', '--port', String(port)]
      : ['tsx', 'watch', (module.split(':')[0] ?? module).replace(/\./g, '/') + '.ts'];

    return {
      cmd,
      args,
      cwd: directory,
      env: { ...process.env, ...envVars, PORT: String(port), LOCAL_DEV: '1' },
    };
  }
}
