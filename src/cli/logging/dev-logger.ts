import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR, findConfigRoot } from '../../lib';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type DevLogLevel = 'info' | 'system' | 'warn' | 'error' | 'response';

/** Log levels that are considered "important" and written to file */
const IMPORTANT_LEVELS = new Set<DevLogLevel>(['system', 'warn', 'error', 'response']);

export interface DevLoggerOptions {
  /** Base directory for agentcore/ (defaults to process.cwd()) */
  baseDir?: string;
  /** Agent name for log header */
  agentName?: string;
  /** Port the server is running on */
  port?: number;
}

/**
 * Logger for dev command execution.
 * Creates log files in agentcore/.cli/logs/dev/ with timestamped filenames.
 * Only logs important messages (system, warn, error, response) - filters out info noise.
 */
export class DevLogger {
  readonly logFilePath: string;
  private readonly startTime: Date;

  constructor(options: DevLoggerOptions = {}) {
    this.startTime = new Date();

    // Find config root - require valid project to exist
    const configRoot = options.baseDir ? path.join(options.baseDir, CONFIG_DIR) : findConfigRoot();
    if (!configRoot || !existsSync(configRoot)) {
      throw new Error('No agentcore project found. Cannot create dev logs.');
    }

    const logsDir = path.join(configRoot, CLI_SYSTEM_DIR, CLI_LOGS_DIR, 'dev');

    // Ensure logs directory exists
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Generate timestamped filename: dev-YYYYMMDD-HHMMSS.log
    const timestamp = this.formatTimestampForFilename(this.startTime);
    this.logFilePath = path.join(logsDir, `dev-${timestamp}.log`);

    // Write header
    this.writeHeader(options);
  }

  /**
   * Format a date for use in filename: YYYYMMDD-HHMMSS
   */
  private formatTimestampForFilename(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
  }

  /**
   * Format a date for log entries: HH:MM:SS
   */
  private formatTime(date: Date = new Date()): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Write the log file header
   */
  private writeHeader(options: DevLoggerOptions): void {
    const separator = '='.repeat(80);
    const agentLine = options.agentName ? `Agent: ${options.agentName}\n` : '';
    const portLine = options.port ? `Port: ${options.port}\n` : '';
    const header = `${separator}
AGENTCORE DEV LOG
${agentLine}${portLine}Started: ${this.startTime.toISOString()}
${separator}

`;
    writeFileSync(this.logFilePath, header, 'utf-8');
  }

  /**
   * Log a message. Only important levels (system, warn, error, response) are written to file.
   */
  log(level: DevLogLevel, message: string): void {
    // Only log important messages to file
    if (!IMPORTANT_LEVELS.has(level)) {
      return;
    }

    const levelPrefix = level === 'response' ? 'RESPONSE' : level.toUpperCase();
    const line = `[${this.formatTime()}] [${levelPrefix}] ${message}`;
    appendFileSync(this.logFilePath, line + '\n', 'utf-8');
  }

  /**
   * Log a raw SSE event for debugging purposes.
   * This logs the full SSE line as received from the server.
   */
  logSSEEvent(rawLine: string): void {
    const line = `[${this.formatTime()}] [SSE] ${rawLine}`;
    appendFileSync(this.logFilePath, line + '\n', 'utf-8');
  }

  /**
   * Finalize the log with a closing message
   */
  finalize(): void {
    const separator = '='.repeat(80);
    const endTime = new Date();
    const duration = endTime.getTime() - this.startTime.getTime();
    const durationStr = this.formatDuration(duration);

    const footer = `
${separator}
SESSION ENDED
Duration: ${durationStr}
${separator}
`;
    appendFileSync(this.logFilePath, footer, 'utf-8');
  }

  /**
   * Format duration in human-readable form
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Get a clickable terminal hyperlink to the log file.
   */
  getClickableLogPath(): string {
    const url = `file://${this.logFilePath}`;
    const displayText = path.relative(process.cwd(), this.logFilePath);
    return `\x1b]8;;${url}\x1b\\${displayText}\x1b]8;;\x1b\\`;
  }

  /**
   * Get the relative path to the log file
   */
  getRelativeLogPath(): string {
    return path.relative(process.cwd(), this.logFilePath);
  }
}
