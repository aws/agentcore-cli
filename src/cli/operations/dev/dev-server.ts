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
/** Keep the last 20 stderr lines so we can surface them if the process crashes.
 *  20 lines is enough to capture a typical Python traceback or error context
 *  without accumulating unbounded memory for long-running servers. */
const STDERR_BUFFER_SIZE = 20;

/** Paths that indicate internal framework frames (not user code) */
const INTERNAL_FRAME_PATTERNS = [
  '/site-packages/',
  '<frozen ',
  '/multiprocessing/',
  '/asyncio/',
  '/concurrent/',
  '/importlib/',
];

function isInternalFrame(line: string): boolean {
  return INTERNAL_FRAME_PATTERNS.some(p => line.includes(p));
}

export abstract class DevServer {
  protected child: ChildProcess | null = null;
  private recentStderr: string[] = [];
  private inTraceback = false;
  private tracebackBuffer: string[] = [];

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

  /**
   * Emit a filtered Python traceback: only user code frames and the exception line.
   * Internal frames (site-packages, frozen modules, asyncio, etc.) are stripped out.
   */
  private emitFilteredTraceback(onLog: (level: LogLevel, message: string) => void): void {
    const buf = this.tracebackBuffer;
    if (buf.length === 0) return;

    // The last line is the exception (e.g., "ModuleNotFoundError: ...")
    const exceptionLine = buf[buf.length - 1]!;

    // Collect user-code frames: a "File ..." line followed by its code line.
    // Frames come in pairs: "  File "path", line N, in func" + "    code_line"
    const userFrames: string[] = [];
    for (let i = 0; i < buf.length - 1; i++) {
      const frameLine = buf[i]!;
      const trimmed = frameLine.trimStart();
      if (trimmed.startsWith('File ') && !isInternalFrame(frameLine)) {
        userFrames.push(frameLine);
        // Include the next line (source code) if it exists and is indented
        const nextLine = buf[i + 1];
        if (nextLine && nextLine.startsWith(' ') && !nextLine.trimStart().startsWith('File ')) {
          userFrames.push(nextLine);
        }
      }
    }

    if (userFrames.length > 0) {
      for (const frame of userFrames) {
        onLog('error', frame);
      }
    }
    onLog('error', exceptionLine);
  }

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
        // Buffer recent stderr for crash context
        this.recentStderr.push(line);
        if (this.recentStderr.length > STDERR_BUFFER_SIZE) {
          this.recentStderr.shift();
        }
        // Detect Python traceback blocks: buffer all lines, then emit a
        // filtered version showing only user code frames + the exception.
        if (line.startsWith('Traceback (most recent call last)')) {
          this.inTraceback = true;
          this.tracebackBuffer = [];
        }
        if (this.inTraceback) {
          this.tracebackBuffer.push(line);
          const isStackFrame = line.startsWith(' ') || line.startsWith('File ');
          const isTracebackHeader = line.startsWith('Traceback ');
          if (!isStackFrame && !isTracebackHeader) {
            // Traceback ended — emit filtered summary and clear the
            // stderr buffer so these lines aren't re-emitted on exit.
            this.emitFilteredTraceback(onLog);
            this.inTraceback = false;
            this.tracebackBuffer = [];
            this.recentStderr = [];
          }
          continue;
        }
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

    this.child?.on('exit', code => {
      if (code !== 0 && code !== null && this.recentStderr.length > 0) {
        for (const line of this.recentStderr) {
          onLog('error', line);
        }
        this.recentStderr = [];
      }
      onExit(code);
    });
  }
}
