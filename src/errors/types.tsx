export const ERROR_SOURCE = {
  // note: this maps to the `client` error source in telemetry.
  INTERNAL: "internal",
  USER: "user",
  SERVICE: "service",
  UNKNOWN: "unknown",
} as const;

/** Describes the source of the error, whether it was the user, internal to the CLI, a service, or unknown. */
export type ErrorSource = (typeof ERROR_SOURCE)[keyof typeof ERROR_SOURCE];

export interface AgentCoreCLIErrorOptions extends ErrorOptions {
  /** The source fo the error. See {@link ErrorSource} for more information */
  source?: ErrorSource;
  /** Abitrary metdata to attach to errors for logging */
  meta?: Record<string, unknown>;
  /** Describes the exitCode for the CLI when this error hits the root handler */
  exitCode?: number;
}

/** Base error for CLI failures, including their source, metadata, and process exit code. */
export class AgentCoreCLIError extends Error {
  readonly source: ErrorSource;
  readonly meta: Record<string, unknown>;
  readonly exitCode: number;

  constructor(message?: string, options?: AgentCoreCLIErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.source = options?.source ?? ERROR_SOURCE.UNKNOWN;
    this.meta = options?.meta ?? {};
    this.exitCode = options?.exitCode ?? 1;
  }
  /** Convert the error into an object with its attributes enumerated as keys **/
  json(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
      exitCode: this.exitCode,
      meta: this.meta,
      source: this.source,
    };
  }
}

/** Error raised for invalid user input. */
export class InputValidationError extends AgentCoreCLIError {
  constructor(message?: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.USER });
  }
}
