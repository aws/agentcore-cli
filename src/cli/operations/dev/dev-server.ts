import type { DevConfig } from './config';
import { type ChildProcess, spawn } from 'child_process';

export type LogLevel = 'info' | 'warn' | 'error' | 'system';

export interface DevServerCallbacks {
  onLog: (level: LogLevel, message: string) => void;
  onExit: (code: number | null) => void;
}

export interface DevServerOptions {
  port: number;
  envVars?: Record<string, string>;
  callbacks: DevServerCallbacks;
}

export interface SpawnConfig {
  cmd: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Abstract base class for dev servers.
 * Handles process spawning, output parsing, and lifecycle management.
 * Subclasses implement prepare() and getSpawnConfig() for mode-specific behavior.
 */
export abstract class DevServer {
  protected child: ChildProcess | null = null;

  constructor(
    protected readonly config: DevConfig,
    protected readonly options: DevServerOptions
  ) {}

  /**
   * Start the dev server. Calls prepare() for setup, then spawns the process.
   * Returns the child process, or null if preparation failed.
   */
  async start(): Promise<ChildProcess | null> {
    const prepared = await this.prepare();
    if (!prepared) {
      this.options.callbacks.onExit(1);
      return null;
    }

    const spawnConfig = this.getSpawnConfig();
    this.child = spawn(spawnConfig.cmd, spawnConfig.args, {
      cwd: spawnConfig.cwd,
      env: spawnConfig.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.attachHandlers();
    return this.child;
  }

  /** Kill the dev server process. Sends SIGTERM, then SIGKILL after 2 seconds. */
  kill(): void {
    if (!this.child || this.child.killed) return;
    this.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.child && !this.child.killed) this.child.kill('SIGKILL');
    }, 2000);
  }

  /** Mode-specific setup (e.g., venv creation, container image build). Returns false to abort. */
  protected abstract prepare(): Promise<boolean>;

  /** Returns the command, args, cwd, and environment for the child process. */
  protected abstract getSpawnConfig(): SpawnConfig;

  /** Attach stdout/stderr/error/exit handlers to the child process. */
  private attachHandlers(): void {
    const { onLog, onExit } = this.options.callbacks;

    this.child?.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (!output) return;
      for (const line of output.split('\n')) {
        if (line) onLog('info', line);
      }
    });

    this.child?.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (!output) return;
      for (const line of output.split('\n')) {
        if (!line) continue;
        const lower = line.toLowerCase();
        if (lower.includes('warning')) onLog('warn', line);
        else if (lower.includes('error')) onLog('error', line);
        else onLog('info', line);
      }
    });

    this.child?.on('error', err => {
      onLog('error', `Failed to start: ${err.message}`);
      onExit(1);
    });

    this.child?.on('exit', code => onExit(code));
  }
}
