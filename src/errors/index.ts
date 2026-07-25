import { ServiceException } from "@smithy/core/client";

export const ERROR_SOURCE = {
  // note: this maps to the `client` error source in telemetry.
  INTERNAL: "internal",
  USER: "user",
  SERVICE: "service",
  UNKNOWN: "unknown",
} as const;

export type ErrorSource = (typeof ERROR_SOURCE)[keyof typeof ERROR_SOURCE];

export interface AgentCoreCLIErrorOptions extends ErrorOptions {
  source?: ErrorSource;
  meta?: Record<string, unknown>;
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

/** Converts any thrown value into an {@link AgentCoreCLIError}, preserving known CLI errors. */
export function classify(error: unknown): AgentCoreCLIError {
  if (error instanceof AgentCoreCLIError) return error;

  if (ServiceException.isInstance(error)) {
    const httpStatusCode = error.$metadata.httpStatusCode;
    const source =
      httpStatusCode !== undefined && httpStatusCode >= 400 && httpStatusCode < 500
        ? ERROR_SOURCE.USER
        : ERROR_SOURCE.SERVICE;

    return new AgentCoreCLIError(error.message, {
      cause: error,
      source,
      // note: we store the original name in meta so we can pull it out in telemetry.
      meta: { ...error.$metadata, name: error.name },
    });
  }

  if (error instanceof Error) return new AgentCoreCLIError(error.message, { cause: error });

  return new AgentCoreCLIError(String(error), { cause: error });
}
