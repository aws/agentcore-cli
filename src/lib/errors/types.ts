/**
 * Error indicating no agentcore project was found in the working directory.
 */
export class NoProjectError extends Error {
  constructor(message?: string) {
    super(message ?? 'No agentcore project found. Run "agentcore create" first.');
    this.name = 'NoProjectError';
  }
}

/**
 * Error thrown when an agent with the same name already exists.
 */
export class AgentAlreadyExistsError extends Error {
  constructor(agentName: string) {
    super(`An agent named "${agentName}" already exists in the schema.`);
    this.name = 'AgentAlreadyExistsError';
  }
}

/**
 * Error indicating an AWS permissions failure (AccessDenied / AccessDeniedException).
 */
export class AccessDeniedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Error indicating missing system dependencies required for an operation.
 */
export class DependencyCheckError extends Error {
  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'DependencyCheckError';
  }
}

/**
 * Error indicating git repository initialization failed.
 */
export class GitInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitInitError';
  }
}

/**
 * Error indicating a referenced resource could not be found.
 */
export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/**
 * Error indicating a network connection failure (e.g., server not reachable).
 */
export class ConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectionError';
  }
}

/**
 * Converts an unknown thrown value to an Error instance.
 * Use in catch blocks to ensure the error field is always an Error object.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Error indicating a resource conflict (e.g., already exists).
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Error indicating an operation timed out or exceeded retry limits.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
