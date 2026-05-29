import { formatZodErrors } from './zod.js';
import { ZodError } from 'zod';

export type ErrorSource = 'user' | 'client' | 'service' | 'unknown';

export interface BaseErrorOptions extends ErrorOptions {
  errorSource?: ErrorSource;
}

interface InternalErrorOptions extends BaseErrorOptions {
  defaultSource: ErrorSource;
}

export abstract class BaseError extends Error {
  readonly errorSource: ErrorSource;

  protected constructor(message: string, options: InternalErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.errorSource = options.errorSource ?? options.defaultSource;
  }
}

/**
 * Converts an unknown thrown value to an Error instance.
 * Use in catch blocks to ensure the error field is always an Error object.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// --- User errors ---

/**
 * Error indicating no agentcore project was found in the working directory.
 */
export class NoProjectError extends BaseError {
  constructor(message?: string, options?: BaseErrorOptions) {
    super(message ?? 'No agentcore project found. Run "agentcore create" first.', {
      defaultSource: 'user',
      ...options,
    });
  }
}

/**
 * Error thrown when an agent with the same name already exists.
 */
export class AgentAlreadyExistsError extends BaseError {
  constructor(agentName: string, options?: BaseErrorOptions) {
    super(`An agent named "${agentName}" already exists in the schema.`, { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating an AWS permissions failure (AccessDenied / AccessDeniedException).
 */
export class AccessDeniedError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating missing system dependencies required for an operation.
 */
export class DependencyCheckError extends BaseError {
  constructor(errors: string[], options?: BaseErrorOptions) {
    super(errors.join('\n'), { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating a referenced resource could not be found.
 */
export class ResourceNotFoundError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating invalid input or configuration values.
 */
export class ValidationError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Error thrown when AWS credentials are not configured or invalid.
 * Supports both a short message (for interactive mode) and detailed message (for CLI mode).
 */
export class AwsCredentialsError extends BaseError {
  readonly shortMessage: string;
  constructor(shortMessage: string, detailedMessage?: string, options?: BaseErrorOptions) {
    super(detailedMessage ?? shortMessage, { defaultSource: 'user', ...options });
    this.shortMessage = shortMessage;
  }
}

/**
 * Error indicating a packaging operation failed.
 */
export class PackagingError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating the packaged artifact exceeds the size limit.
 */
export class ArtifactSizeError extends PackagingError {
  constructor(limitBytes: number, actualBytes: number, options?: BaseErrorOptions) {
    super(`Packaged artifact exceeds ${limitBytes} bytes (actual: ${actualBytes}).`, options);
  }
}

/**
 * Error indicating a required binary or tool is not installed.
 */
export class MissingDependencyError extends PackagingError {
  constructor(binary: string, installHint?: string, options?: BaseErrorOptions) {
    super(installHint ? `${binary} is required. ${installHint}` : `${binary} is required.`, options);
  }
}

/**
 * Error indicating a required project file is missing.
 */
export class MissingProjectFileError extends PackagingError {
  constructor(filePath: string, options?: BaseErrorOptions) {
    super(`Required project file not found: ${filePath}`, options);
  }
}

/**
 * Error indicating the project language is not supported for packaging.
 */
export class UnsupportedLanguageError extends PackagingError {
  constructor(language: string, options?: BaseErrorOptions) {
    super(`${language} packaging is not supported yet.`, options);
  }
}

// --- Config errors (user) ---

/**
 * Base class for all config-related errors.
 */
export abstract class ConfigError extends BaseError {
  protected constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Thrown when a config file doesn't exist.
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
 * Thrown when a config file can't be read.
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
 * Thrown when a config file can't be written.
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
 * Thrown when config validation fails.
 */
export class ConfigValidationError extends ConfigError {
  constructor(
    public readonly filePath: string,
    public readonly fileType: string,
    public readonly zodError: ZodError
  ) {
    super(`${filePath}:\n${formatZodErrors(zodError.issues)}`);
  }
}

/**
 * Thrown when JSON parsing fails.
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

// --- Client errors ---

/**
 * Error indicating git repository initialization failed.
 */
export class GitInitError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'client', ...options });
  }
}

// --- Service errors ---

/**
 * Error indicating a resource conflict (e.g., already exists).
 */
export class ConflictError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'user', ...options });
  }
}

/**
 * Error indicating an operation timed out or exceeded retry limits.
 */
export class TimeoutError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'service', ...options });
  }
}

/**
 * Error thrown when the dev server returns a non-OK HTTP response.
 */
export class ServerError extends BaseError {
  constructor(
    public readonly statusCode: number,
    body: string,
    options?: BaseErrorOptions
  ) {
    super(body || `Server returned ${statusCode}`, { defaultSource: 'client', ...options });
  }
}

/**
 * Error thrown when the connection to the dev server fails.
 */
export class ConnectionError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, { defaultSource: 'client', ...options });
  }
}

/**
 * Error indicating polling timed out.
 */
export class PollTimeoutError extends BaseError {
  constructor(timeoutMs: number, options?: BaseErrorOptions) {
    super(`Polling timed out after ${timeoutMs}ms`, { defaultSource: 'service', ...options });
  }
}

/**
 * Error indicating polling exhausted all retry attempts.
 */
export class PollExhaustedError extends BaseError {
  constructor(maxAttempts: number, options?: BaseErrorOptions) {
    super(`Polling exhausted after ${maxAttempts} attempts`, { defaultSource: 'service', ...options });
  }
}

/**
 * Error indicating user cancellation interuption
 */
export class UserCancellationError extends BaseError {
  constructor(options?: BaseErrorOptions) {
    super(`User cancelled`, { defaultSource: 'user', ...options });
  }
}
