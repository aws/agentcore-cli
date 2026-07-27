import { ServiceException } from "@smithy/core/client";
import { ERROR_SOURCE, type ErrorSource } from "./types";

export interface AgentCoreCLIErrorOptions extends ErrorOptions {
  /** The source fo the error. See {@link ErrorSource} for more information */
  source?: ErrorSource;
  /** Arbitrary metdata to attach to errors for logging */
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
    this.source = options?.source ?? ERROR_SOURCE.INTERNAL;
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

  static fromError(error: unknown): AgentCoreCLIError {
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
        meta: { ...error.$metadata },
      });
    }

    if (error instanceof Error) return new AgentCoreCLIError(error.message, { cause: error });

    return new AgentCoreCLIError(String(error), { cause: error });
  }
}

/** Error raised for invalid user input. */
export class InputValidationError extends AgentCoreCLIError {
  constructor(message?: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.USER });
  }
}
