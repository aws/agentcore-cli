import { ZodError } from 'zod';

/**
 * Base class for all config-related errors
 */
export abstract class ConfigError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when a config file doesn't exist
 */
export class ConfigNotFoundError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public readonly fileType: string
  ) {
    super(`${fileType} config file not found at: ${filePath}`);
  }
}

/**
 * Thrown when a config file can't be read
 */
export class ConfigReadError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public override readonly cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to read config file at ${filePath}: ${message}`);
  }
}

/**
 * Thrown when a config file can't be written
 */
export class ConfigWriteError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public override readonly cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to write config file at ${filePath}: ${message}`);
  }
}

/**
 * Format a Zod path array to bracket notation: agents[0].name
 */
function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return 'root';
  return path
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : i === 0 ? String(segment) : `.${String(segment)}`
    )
    .join('');
}

// Zod issue with extended properties for type-safe access (Zod 4 compatible)
interface ZodIssueExt {
  code: string;
  path: PropertyKey[];
  message: string;
  expected?: unknown;
  received?: unknown;
  options?: unknown[]; // Zod 3
  values?: unknown[]; // Zod 4
  keys?: string[];
  unionErrors?: { issues: ZodIssueExt[] }[]; // Zod 3
  errors?: ZodIssueExt[]; // Zod 4
  discriminator?: string; // Zod 4 discriminated union
}

/**
 * Format a single Zod issue into an actionable message.
 * Augments common cases with "got X, expected Y" format.
 * Falls back to Zod's message for unhandled cases.
 */
function formatZodIssue(issue: ZodIssueExt): string {
  const path = formatPath(issue.path);

  switch (issue.code) {
    case 'invalid_type':
      if (issue.expected !== undefined) {
        if (issue.received !== undefined) {
          return `${path}: got ${JSON.stringify(issue.received)}, expected ${JSON.stringify(issue.expected)}`;
        }
        return `${path}: expected ${JSON.stringify(issue.expected)}`;
      }
      break;

    case 'invalid_enum_value':
    case 'invalid_value': {
      const opts = issue.options ?? issue.values;
      if (Array.isArray(opts)) {
        const expectedStr = opts.map(o => `"${String(o)}"`).join(' | ');
        if (issue.received !== undefined) {
          return `${path}: got ${JSON.stringify(issue.received)}, expected ${expectedStr}`;
        }
        return `${path}: expected ${expectedStr}`;
      }
      break;
    }

    case 'invalid_literal':
      if (issue.received !== undefined && issue.expected !== undefined) {
        return `${path}: got ${JSON.stringify(issue.received)}, expected ${JSON.stringify(issue.expected)}`;
      }
      break;

    case 'unrecognized_keys':
      if (Array.isArray(issue.keys)) {
        return `${path}: unknown keys (remove): ${issue.keys.map(k => `"${k}"`).join(', ')}`;
      }
      break;

    case 'invalid_union': {
      // Zod 4 discriminated union: show discriminator field and valid options
      if (issue.discriminator) {
        return `${path}: invalid "${issue.discriminator}" value`;
      }
      // Pick the most actionable error from union failures (one fix, not all branches)
      const unionErrors = issue.unionErrors?.flatMap(e => e.issues) ?? issue.errors ?? [];
      for (const err of unionErrors) {
        if (err.code === 'invalid_enum_value' || err.code === 'invalid_value') {
          return formatZodIssue(err);
        }
      }
      for (const err of unionErrors) {
        if (err.code === 'invalid_type') {
          return formatZodIssue(err);
        }
      }
      const firstError = unionErrors[0];
      if (firstError) return formatZodIssue(firstError);
      break;
    }

    case 'invalid_union_discriminator': {
      const opts = issue.options ?? issue.values;
      if (Array.isArray(opts)) {
        return `${path}: expected ${opts.map(o => `"${String(o)}"`).join(' | ')}`;
      }
      break;
    }
  }

  // Fail open: unhandled cases use Zod's message verbatim.
  // Some Zod 3/4 shape mismatches produce issues with no .message — fall back to the code
  // so users see something actionable instead of the literal string "undefined".
  const message = issue.message ?? issue.code ?? 'invalid value';
  return `${path}: ${message}`;
}

/**
 * Thrown when config validation fails
 */
export class ConfigValidationError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public readonly fileType: string,
    public readonly zodError: ZodError
  ) {
    const formattedErrors = (zodError.issues as ZodIssueExt[]).map(issue => `  - ${formatZodIssue(issue)}`).join('\n');
    super(`${filePath}:\n${formattedErrors}`);
  }
}

/**
 * Thrown when JSON parsing fails
 */
export class ConfigParseError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public override readonly cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse JSON in config file at ${filePath}: ${message}`);
  }
}
