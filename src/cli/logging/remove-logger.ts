import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR, findConfigRoot } from '../../lib';
import type { RemovalPreview } from '../operations/remove';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REMOVE_LOGS_SUBDIR = 'remove';

export interface RemoveLoggerOptions {
  /** Type of resource being removed */
  resourceType: 'agent' | 'memory' | 'identity' | 'gateway' | 'mcp-tool';
  /** Name of the resource being removed */
  resourceName: string;
}

/**
 * Compute a unified diff between two JSON objects.
 * Returns lines prefixed with +/- for additions/removals.
 */
function computeJsonDiff(before: unknown, after: unknown): string[] {
  const beforeLines = JSON.stringify(before, null, 2).split('\n');
  const afterLines = JSON.stringify(after, null, 2).split('\n');

  // Build LCS table
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to build diff
  let i = m;
  let j = n;

  const tempDiff: string[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      tempDiff.unshift(`  ${beforeLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      tempDiff.unshift(`+ ${afterLines[j - 1]}`);
      j--;
    } else if (i > 0) {
      tempDiff.unshift(`- ${beforeLines[i - 1]}`);
      i--;
    }
  }

  return tempDiff;
}

/**
 * Logger for remove command execution.
 * Creates log files in agentcore/.cli/logs/remove/ with timestamped filenames.
 * Includes the schema diff showing what was changed.
 */
export class RemoveLogger {
  readonly logFilePath: string;
  private readonly startTime: Date;
  private readonly options: RemoveLoggerOptions;

  constructor(options: RemoveLoggerOptions) {
    this.options = options;
    this.startTime = new Date();

    // Find config root or fall back to cwd
    const configRoot = findConfigRoot();
    const removeLogsDir = configRoot
      ? path.resolve(configRoot, CLI_SYSTEM_DIR, CLI_LOGS_DIR, REMOVE_LOGS_SUBDIR)
      : path.resolve(process.cwd(), CONFIG_DIR, CLI_SYSTEM_DIR, CLI_LOGS_DIR, REMOVE_LOGS_SUBDIR);

    // Ensure remove logs directory exists
    if (!existsSync(removeLogsDir)) {
      mkdirSync(removeLogsDir, { recursive: true });
    }

    // Generate timestamped filename: remove-type-name-YYYYMMDD-HHMMSS.log
    const timestamp = this.formatTimestampForFilename(this.startTime);
    const safeName = options.resourceName.replace(/[^a-zA-Z0-9-_]/g, '_');
    this.logFilePath = path.resolve(removeLogsDir, `remove-${options.resourceType}-${safeName}-${timestamp}.log`);
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
   * Log a removal operation with the preview and schema changes.
   */
  logRemoval(preview: RemovalPreview, success: boolean, error?: string): void {
    const lines: string[] = [];
    const separator = '='.repeat(80);

    // Header
    lines.push(separator);
    lines.push('AGENTCORE REMOVE LOG');
    lines.push(`Resource Type: ${this.options.resourceType}`);
    lines.push(`Resource Name: ${this.options.resourceName}`);
    lines.push(`Timestamp: ${this.startTime.toISOString()}`);
    lines.push(`Status: ${success ? 'SUCCESS' : 'FAILED'}`);
    if (error) {
      lines.push(`Error: ${error}`);
    }
    lines.push(separator);
    lines.push('');

    // Summary
    lines.push('--- SUMMARY ---');
    for (const line of preview.summary) {
      lines.push(line);
    }
    lines.push('');

    // Schema diff
    if (preview.schemaChanges.length > 0) {
      lines.push('--- SCHEMA DIFF ---');
      for (const change of preview.schemaChanges) {
        lines.push(`File: ${change.file}`);
        lines.push('-'.repeat(40));
        const diffLines = computeJsonDiff(change.before, change.after);
        lines.push(...diffLines);
        lines.push('');
      }
    }

    lines.push(separator);
    lines.push(`End of log: ${new Date().toISOString()}`);

    writeFileSync(this.logFilePath, lines.join('\n'), 'utf-8');
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
}
