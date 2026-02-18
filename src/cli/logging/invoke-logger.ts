import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR, findConfigRoot } from '../../lib';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const INVOKE_LOGS_SUBDIR = 'invoke';

export interface InvokeLoggerOptions {
  /** Agent name being invoked */
  agentName: string;
  /** Runtime ARN */
  runtimeArn: string;
  /** AWS region */
  region: string;
  /** Session ID for conversation continuity */
  sessionId?: string;
}

interface InvokeRequestLog {
  timestamp: string;
  agent: string;
  runtimeArn: string;
  region: string;
  sessionId?: string;
  userId?: string;
  prompt: string;
}

interface InvokeResponseLog {
  timestamp: string;
  durationMs: number;
  success: boolean;
  response?: string;
  error?: {
    message: string;
    name: string;
    stack?: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Logger for invoke command execution.
 * Creates log files in agentcore/.cli/logs/invoke/ with timestamped filenames.
 * Includes structured JSON sections for request and response data.
 */
export class InvokeLogger {
  readonly logFilePath: string;
  private readonly startTime: Date;
  private readonly options: InvokeLoggerOptions;
  private requestLog: InvokeRequestLog | null = null;
  private promptStartTime: number | null = null;

  constructor(options: InvokeLoggerOptions) {
    this.options = options;
    this.startTime = new Date();

    // Find config root or fall back to cwd
    const configRoot = findConfigRoot();
    const invokeLogsDir = configRoot
      ? path.resolve(configRoot, CLI_SYSTEM_DIR, CLI_LOGS_DIR, INVOKE_LOGS_SUBDIR)
      : path.resolve(process.cwd(), CONFIG_DIR, CLI_SYSTEM_DIR, CLI_LOGS_DIR, INVOKE_LOGS_SUBDIR);

    // Ensure invoke logs directory exists
    if (!existsSync(invokeLogsDir)) {
      mkdirSync(invokeLogsDir, { recursive: true });
    }

    // Generate timestamped filename: invoke-agentname-YYYYMMDD-HHMMSS.log
    const timestamp = this.formatTimestampForFilename(this.startTime);
    const safeName = options.agentName.replace(/[^a-zA-Z0-9-_]/g, '_');
    // Ensure absolute path
    this.logFilePath = path.resolve(invokeLogsDir, `invoke-${safeName}-${timestamp}.log`);

    // Write header immediately to ensure file exists
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
   * Format a date for log entries: HH:MM:SS.mmm
   */
  private formatTime(date: Date = new Date()): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }

  /**
   * Write the log file header
   */
  private writeHeader(): void {
    const separator = '='.repeat(80);
    const header = `${separator}
AGENTCORE INVOKE LOG
Agent: ${this.options.agentName}
Runtime ARN: ${this.options.runtimeArn}
Region: ${this.options.region}
Session ID: ${this.options.sessionId ?? 'none'}
Started: ${this.startTime.toISOString()}
${separator}

`;
    writeFileSync(this.logFilePath, header, 'utf-8');
  }

  /**
   * Append a line to the log file
   */
  private appendLine(line: string): void {
    appendFileSync(this.logFilePath, line + '\n', 'utf-8');
  }

  /**
   * Append a JSON block to the log file
   */
  private appendJson(label: string, data: unknown): void {
    this.appendLine(`\n--- ${label} ---`);
    this.appendLine(JSON.stringify(data, null, 2));
    this.appendLine(`--- END ${label} ---\n`);
  }

  /**
   * Log a prompt being sent with full request details
   */
  logPrompt(prompt: string, sessionId?: string, userId?: string): void {
    this.promptStartTime = Date.now();
    const currentSessionId = sessionId ?? this.options.sessionId;
    this.requestLog = {
      timestamp: new Date().toISOString(),
      agent: this.options.agentName,
      runtimeArn: this.options.runtimeArn,
      region: this.options.region,
      sessionId: currentSessionId,
      userId,
      prompt,
    };

    this.appendLine(`[${this.formatTime()}] INVOKE REQUEST (Session: ${currentSessionId ?? 'none'})`);
    this.appendJson('REQUEST', this.requestLog);
  }

  /**
   * Update the session ID (e.g., when received from response)
   */
  updateSessionId(sessionId: string): void {
    this.options.sessionId = sessionId;
    this.appendLine(`[${this.formatTime()}] SESSION ID UPDATED: ${sessionId}`);
  }

  /**
   * Log a successful response chunk (for streaming)
   */
  logChunk(chunk: string): void {
    this.appendLine(`[${this.formatTime()}] CHUNK: ${chunk.length} chars`);
  }

  /**
   * Log a raw SSE event for debugging purposes.
   * This logs the full SSE line as received from the server.
   */
  logSSEEvent(rawLine: string): void {
    this.appendLine(`[${this.formatTime()}] SSE: ${rawLine}`);
  }

  /**
   * Log a successful response with full details
   */
  logResponse(response: string): void {
    const durationMs = this.promptStartTime ? Date.now() - this.promptStartTime : 0;

    this.appendLine(`[${this.formatTime()}] INVOKE RESPONSE (${durationMs}ms)`);

    const responseLog: InvokeResponseLog = {
      timestamp: new Date().toISOString(),
      durationMs,
      success: true,
      response,
    };

    this.appendJson('RESPONSE', responseLog);
  }

  /**
   * Log an error with full details
   */
  logError(error: unknown, context?: string): void {
    const timestamp = this.formatTime();
    const durationMs = this.promptStartTime ? Date.now() - this.promptStartTime : 0;

    if (context) {
      this.appendLine(`[${timestamp}] ERROR CONTEXT: ${context}`);
    }

    const responseLog: InvokeResponseLog = {
      timestamp: new Date().toISOString(),
      durationMs,
      success: false,
    };

    if (error instanceof Error) {
      this.appendLine(`[${timestamp}] ERROR: ${error.message}`);
      this.appendLine(`[${timestamp}] ERROR NAME: ${error.name}`);

      responseLog.error = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        metadata: {},
      };

      if (error.stack) {
        this.appendLine(`[${timestamp}] STACK TRACE:`);
        for (const line of error.stack.split('\n')) {
          this.appendLine(`  ${line}`);
        }
      }

      // Log any additional properties on the error (like AWS SDK metadata)
      const errorObj = error as unknown as Record<string, unknown>;
      for (const key of Object.keys(errorObj)) {
        if (key !== 'message' && key !== 'name' && key !== 'stack') {
          try {
            const value = errorObj[key];
            let stringValue: string;
            if (typeof value === 'object' && value !== null) {
              stringValue = JSON.stringify(value);
            } else if (value === null || value === undefined) {
              stringValue = '';
            } else {
              stringValue = String(value as string | number | boolean);
            }
            this.appendLine(`[${timestamp}] ERROR.${key}: ${stringValue}`);
            if (responseLog.error?.metadata) {
              responseLog.error.metadata[key] = value;
            }
          } catch {
            // Ignore serialization errors
          }
        }
      }
    } else {
      this.appendLine(`[${timestamp}] ERROR: ${String(error)}`);
      responseLog.error = {
        message: String(error),
        name: 'UnknownError',
      };
    }

    this.appendJson('RESPONSE', responseLog);
  }

  /**
   * Log an info message
   */
  logInfo(message: string): void {
    this.appendLine(`[${this.formatTime()}] INFO: ${message}`);
  }

  /**
   * Get the relative path to the log file (for display)
   */
  getRelativeLogPath(): string {
    return path.relative(process.cwd(), this.logFilePath);
  }

  /**
   * Get the absolute path to the log file
   */
  getAbsoluteLogPath(): string {
    return this.logFilePath;
  }

  /**
   * Get a clickable terminal hyperlink to the log file.
   * Uses OSC 8 escape sequence for terminal hyperlinks.
   * Displays the short relative path but links to the full file:// URL.
   */
  getClickableLogPath(): string {
    const url = `file://${this.logFilePath}`;
    const displayText = this.getRelativeLogPath();
    // OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
    return `\x1b]8;;${url}\x1b\\${displayText}\x1b]8;;\x1b\\`;
  }
}
