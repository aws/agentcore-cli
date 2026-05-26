import { getVenvExecutable } from '../../../lib/utils/platform';
import type { ProtocolMode } from '../../../schema';
import { DevServer, type LogLevel, type SpawnConfig } from './dev-server';
import { convertEntrypointToModule } from './utils';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * Ensures a Python virtual environment exists and has dependencies installed.
 * Creates the venv and runs uv sync if .venv doesn't exist.
 * For non-HTTP protocols, checks for python instead of uvicorn.
 * Returns true if successful, false otherwise.
 */
function ensurePythonVenv(
  cwd: string,
  onLog: (level: LogLevel, message: string) => void,
  protocol: ProtocolMode = 'HTTP'
): boolean {
  const venvPath = join(cwd, '.venv');

  if (protocol === 'HTTP') {
    // For HTTP, uvicorn binary is a reliable proxy for "deps installed"
    const uvicornPath = getVenvExecutable(venvPath, 'uvicorn');
    if (existsSync(uvicornPath)) {
      return true;
    }
  } else {
    // For MCP/A2A, check python binary as a proxy for "venv + deps installed"
    const pythonPath = getVenvExecutable(venvPath, 'python');
    if (existsSync(pythonPath)) {
      return true;
    }
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
    if (protocol === 'HTTP') {
      // Fallback: try installing uvicorn directly if uv sync fails
      onLog('warn', 'uv sync failed, trying direct uvicorn install...');
      const pipResult = spawnSync('uv', ['pip', 'install', 'uvicorn'], { cwd, stdio: 'pipe' });
      if (pipResult.status !== 0) {
        onLog('error', `Failed to install dependencies: ${pipResult.stderr?.toString() || 'unknown error'}`);
        return false;
      }
    } else {
      onLog('error', `Failed to install dependencies: ${syncResult.stderr?.toString() || 'unknown error'}`);
      return false;
    }
  }

  onLog('system', 'Python environment ready');
  return true;
}

/**
 * Ensures Node dependencies are installed. Runs the appropriate package manager
 * install if `node_modules` is missing. Detects pnpm/yarn via lockfile, else npm.
 */
function ensureNodeDeps(cwd: string, onLog: (level: LogLevel, message: string) => void): boolean {
  if (existsSync(join(cwd, 'node_modules'))) {
    return true;
  }

  let cmd = 'npm';
  let args = ['install'];
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    cmd = 'pnpm';
    args = ['install'];
  } else if (existsSync(join(cwd, 'yarn.lock'))) {
    cmd = 'yarn';
    args = ['install'];
  }

  onLog('system', 'Installing Node dependencies...');
  const result = spawnSync(cmd, args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    onLog('error', `Failed to install Node dependencies: ${result.stderr?.toString() || 'unknown error'}`);
    return false;
  }
  onLog('system', 'Node dependencies ready');
  return true;
}

/**
 * Locate the directory containing OpenTelemetry's auto-instrumentation sitecustomize.py.
 * When this directory is prepended to PYTHONPATH, Python will execute sitecustomize.py
 * on startup, which bootstraps OTEL auto-instrumentation in every process.
 */
function findOtelSitecustomizeDir(venvPath: string): string | undefined {
  // opentelemetry-instrument stores its sitecustomize.py at:
  // <site-packages>/opentelemetry/instrumentation/auto_instrumentation/sitecustomize.py
  // We need the parent directory so Python finds the file as `sitecustomize.py`.
  const result = spawnSync(
    getVenvExecutable(venvPath, 'python'),
    [
      '-c',
      'import opentelemetry.instrumentation.auto_instrumentation as m; import os; print(os.path.dirname(m.__file__))',
    ],
    { cwd: venvPath, stdio: 'pipe' }
  );
  if (result.status === 0) {
    const dir = result.stdout.toString().trim();
    if (dir && existsSync(join(dir, 'sitecustomize.py'))) {
      return dir;
    }
  }
  return undefined;
}

/** Dev server for CodeZip agents. Runs uvicorn (Python) or npx tsx (Node.js) locally. */
export class CodeZipDevServer extends DevServer {
  protected prepare(): Promise<boolean> {
    return Promise.resolve(
      this.config.isPython
        ? ensurePythonVenv(this.config.directory, this.options.callbacks.onLog, this.config.protocol)
        : ensureNodeDeps(this.config.directory, this.options.callbacks.onLog)
    );
  }

  protected getSpawnConfig(): SpawnConfig {
    const { module, directory, isPython, protocol } = this.config;
    const { port, envVars = {} } = this.options;
    const env: Record<string, string | undefined> = { ...process.env, ...envVars, PORT: String(port), LOCAL_DEV: '1' };

    // FastMCP declares FASTMCP_PORT via pydantic BaseSettings (env_prefix="FASTMCP_"),
    // but its __init__ passes port=8000 as an init kwarg to Settings(), which takes
    // priority over env vars in pydantic v2. So this env var is currently ineffective —
    // the agent always binds to 8000. We still set it for forward compatibility in case
    // a future MCP SDK release fixes the override. The dev server targets port 8000.
    if (protocol === 'MCP') {
      env.FASTMCP_PORT = String(port);
    }

    if (!isPython) {
      // TS entrypoint is already a file path like "main.ts" — pass it straight to tsx.
      const entryFile = module.split(':')[0] ?? module;
      return {
        cmd: 'npx',
        args: ['tsx', 'watch', entryFile],
        cwd: directory,
        env,
      };
    }

    const venvDir = join(directory, '.venv');

    // Enable OTEL auto-instrumentation via sitecustomize.py injection.
    // We can't use `opentelemetry-instrument` as a wrapper because uvicorn's
    // --reload runs two processes: a reloader (parent) that watches files, and
    // a worker (child) that actually serves requests. The wrapper only instruments
    // the reloader — when it respawns the worker on file changes, the new worker
    // is a fresh Python process with no tracing, so requests go untraced.
    // Instead, we prepend the OTEL sitecustomize.py directory to PYTHONPATH.
    // Python executes sitecustomize.py automatically on startup in every process,
    // so both the reloader and every worker it spawns get instrumented.
    const otelSitecustomizeDir = findOtelSitecustomizeDir(venvDir);
    if (envVars.OTEL_EXPORTER_OTLP_ENDPOINT && otelSitecustomizeDir) {
      const existingPythonPath = env.PYTHONPATH ?? '';
      env.PYTHONPATH = existingPythonPath
        ? `${otelSitecustomizeDir}${delimiter}${existingPythonPath}`
        : otelSitecustomizeDir;
    }

    if (protocol !== 'HTTP') {
      // MCP/A2A/AGUI: run python main.py directly (no module-level ASGI app)
      const python = getVenvExecutable(venvDir, 'python');
      const entryFile = module.split(':')[0] ?? module;
      return { cmd: python, args: [entryFile], cwd: directory, env };
    }

    // HTTP: uvicorn with hot-reload (existing behavior)
    const uvicorn = getVenvExecutable(venvDir, 'uvicorn');
    return {
      cmd: uvicorn,
      args: [convertEntrypointToModule(module), '--reload', '--host', '127.0.0.1', '--port', String(port)],
      cwd: directory,
      env,
    };
  }
}
