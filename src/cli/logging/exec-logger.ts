import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR, findConfigRoot } from '../../lib';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Strip ANSI escape codes from a string. */
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

export interface ExecLoggerOptions {
  /** Command name for the log file (e.g., 'deploy', 'destroy') */
  command: string;
  /** Base directory for agentcore/ (defaults to process.cwd()) */
  baseDir?: string;
}

interface StepInfo {
  name: string;
  startTime: number;
}

/**
 * Structured logger for CLI command execution.
 * Creates log files in agentcore/.cli/logs/ with timestamped filenames.
 * Tracks execution steps with timing and status information.
 */
export class ExecLogger {
  readonly logFilePath: string;
  private readonly startTime: Date;
  private readonly command: string;
  private currentStep: StepInfo | null = null;
  private lastFailedStep: string | null = null;

  constructor(options: ExecLoggerOptions) {
    this.command = options.command;
    this.startTime = new Date();

    // Use provided baseDir, or auto-discover project root, or fall back to cwd
    const configRoot = options.baseDir ? path.join(options.baseDir, CONFIG_DIR) : findConfigRoot();
    const logsDir = configRoot
      ? path.join(configRoot, CLI_SYSTEM_DIR, CLI_LOGS_DIR, options.command)
      : path.join(process.cwd(), CONFIG_DIR, CLI_SYSTEM_DIR, CLI_LOGS_DIR, options.command);

    // Ensure logs directory exists
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Generate timestamped filename: command-YYYYMMDD-HHMMSS.log
    const timestamp = this.formatTimestampForFilename(this.startTime);
    this.logFilePath = path.join(logsDir, `${options.command}-${timestamp}.log`);

    // Write header
    this.writeHeader();
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
   * Write the log file header
   */
  private writeHeader(): void {
    const separator = '='.repeat(80);
    const header = `${separator}
AGENTCORE ${this.command.toUpperCase()} LOG
Command: ${this.command}
Started: ${this.startTime.toISOString()}
${separator}

`;
    writeFileSync(this.logFilePath, header, 'utf-8');
  }

  /**
   * Append a line to the log file
   */
  appendLine(line: string): void {
    appendFileSync(this.logFilePath, line + '\n', 'utf-8');
  }

  /**
   * Mark the start of a step
   */
  startStep(name: string): void {
    // End previous step if any (shouldn't happen but be safe)
    if (this.currentStep) {
      this.endStep('success');
    }

    this.currentStep = {
      name,
      startTime: Date.now(),
    };

    this.appendLine('');
    this.appendLine(`[${this.formatTime()}] STEP: ${name}`);
  }

  /**
   * Mark the end of the current step.
   * @param message Optional error or warning detail logged with the step outcome.
   */
  endStep(status: 'success' | 'error' | 'warn', message?: string): void {
    if (!this.currentStep) {
      return;
    }

    const duration = Date.now() - this.currentStep.startTime;
    const statusText = status === 'success' ? 'SUCCESS' : status === 'warn' ? 'WARNING' : 'FAILED';

    if (status === 'error') {
      this.lastFailedStep = this.currentStep.name;
    }
    if ((status === 'error' || status === 'warn') && message) {
      this.appendLine(`[${this.formatTime()}] ${status === 'error' ? 'Error' : 'Warning'}: ${message}`);
    }

    this.appendLine(`[${this.formatTime()}] Status: ${statusText}`);
    this.appendLine(`[${this.formatTime()}] Duration: ${this.formatDuration(duration)}`);

    this.currentStep = null;
  }

  /**
   * Log a message with optional level
   */
  log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void {
    const levelPrefix = level && level !== 'info' ? `[${level.toUpperCase()}] ` : '';
    this.appendLine(`[${this.formatTime()}] ${levelPrefix}${message}`);
  }

  /**
   * Log a CDK diff block. Strips ANSI codes and writes each line cleanly.
   * Multi-line messages (like I4002 per-stack diffs) are written with a section header.
   */
  logDiff(code: string, message: string): void {
    if (!message) return;
    const clean = stripAnsi(message);
    const lines = clean.split('\n');

    if (code === 'CDK_TOOLKIT_I4002') {
      // Per-stack diff — write as a clear section
      this.appendLine('');
      this.appendLine(`${'─'.repeat(80)}`);
      for (const line of lines) {
        this.appendLine(line);
      }
      this.appendLine(`${'─'.repeat(80)}`);
    } else if (code === 'CDK_TOOLKIT_I4001') {
      // Overall diff summary
      this.appendLine('');
      this.appendLine(clean);
    } else if (lines.length > 1) {
      // Other multi-line messages — log each line
      for (const line of lines) {
        if (line.trim()) {
          this.appendLine(`[${this.formatTime()}] ${line}`);
        }
      }
    } else {
      this.appendLine(`[${this.formatTime()}] ${clean}`);
    }
  }

  /**
   * Finalize the log file with a summary
   */
  finalize(success: boolean): void {
    // End any in-progress step
    if (this.currentStep) {
      this.endStep(success ? 'success' : 'error');
    }

    const totalDuration = Date.now() - this.startTime.getTime();
    const separator = '='.repeat(80);
    const statusText = success ? 'COMPLETED SUCCESSFULLY' : 'FAILED';

    this.appendLine('');
    this.appendLine(separator);
    this.appendLine(statusText);
    this.appendLine(`Total Duration: ${this.formatDuration(totalDuration)}`);
    this.appendLine(separator);
  }

  /**
   * Get a formatted error message for TUI display.
   * Shows a clickable link to the log file.
   * @param stepName Optional step name to include in the message
   */
  getFailureMessage(stepName?: string): string {
    const prefix = stepName ? `${stepName} failed.` : 'Operation failed.';
    return `${prefix}\nView details:\n${this.getClickableLogPath()}`;
  }

  /**
   * Get a clickable terminal hyperlink to the log file.
   * Uses OSC 8 escape sequence for terminal hyperlinks.
   * Displays the short relative path but links to the full file:// URL.
   */
  getClickableLogPath(): string {
    const url = `file://${this.logFilePath}`;
    const displayText = path.relative(process.cwd(), this.logFilePath);
    // OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
    return `\x1b]8;;${url}\x1b\\${displayText}\x1b]8;;\x1b\\`;
  }

  /**
   * Get the log file path as a file:// URL.
   */
  getLogFileUrl(): string {
    return `file://${this.logFilePath}`;
  }

  /**
   * Get the relative path to the log file (for cleaner display)
   */
  getRelativeLogPath(): string {
    return path.relative(process.cwd(), this.logFilePath);
  }
}
