import { ServiceException } from "@smithy/core/client";
import { CommanderError } from "commander";
import { join } from "node:path";
import { ERROR_SOURCE, type ErrorSource } from "./types";

export interface AgentCoreCLIErrorOptions extends ErrorOptions {
  /** The source fo the error. See {@link ErrorSource} for more information */
  source?: ErrorSource;
  /** Arbitrary metdata to attach to errors for logging */
  meta?: Record<string, unknown>;
  /** Describes the exitCode for the CLI when this error hits the root handler */
  exitCode?: number;
  /** Describes the name of the underlying error, defaults to AgentCoreCLIError */
  name?: string;
}

/** Base error for CLI failures, including their source, metadata, and process exit code. */
export class AgentCoreCLIError extends Error {
  readonly source: ErrorSource;
  readonly meta: Record<string, unknown>;
  readonly exitCode: number;

  constructor(message?: string, options?: AgentCoreCLIErrorOptions) {
    super(message, options);
    this.name = options?.name ?? new.target.name;
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

    if (error instanceof CommanderError) {
      return new SilentCLIError(error.message, {
        cause: error,
        source: ERROR_SOURCE.USER,
        name: error.name,
        meta: { code: error.code },
        exitCode: error.exitCode === 0 ? 0 : 2,
      });
    }

    if (ServiceException.isInstance(error)) {
      const httpStatusCode = error.$metadata.httpStatusCode;
      const source =
        httpStatusCode !== undefined && httpStatusCode >= 400 && httpStatusCode < 500
          ? ERROR_SOURCE.USER
          : ERROR_SOURCE.SERVICE;

      return new AgentCoreCLIError(error.message, {
        cause: error,
        source,
        name: error.name,
        meta: { ...error.$metadata },
      });
    }

    if (error instanceof Error) return new AgentCoreCLIError(error.message, { cause: error });

    return new AgentCoreCLIError(String(error), { cause: error });
  }
}

/** Base for CLI errors intentionally omitted from root stderr output. */
export class SilentCLIError extends AgentCoreCLIError {}

/** Error raised for invalid user input. */
export class InputValidationError extends AgentCoreCLIError {
  constructor(message?: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.USER });
  }
}

/** Error raised when valid user input references a resource that does not exist. */
export class ResourceNotFoundError extends InputValidationError {}

/** Error raised when a command or operation has not been implemented yet. */
export class NotImplementedError extends AgentCoreCLIError {
  constructor(message?: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message ?? "not implemented yet", { ...options, source: ERROR_SOURCE.INTERNAL });
  }
}

/** Error raised when detecting an invalid environment */
export class InvalidEnvironmentError extends AgentCoreCLIError {
  constructor(message?: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.USER });
  }
}

export class SourceResolutionError extends InputValidationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceResolutionError";
  }
}

type DeserializationErrorOptions = Omit<AgentCoreCLIErrorOptions, "source"> & {
  /**
   * Why the file could not be read. Required because the root handler prints
   * only `error.message`: a detail left in `cause` never reaches the user, and
   * these files are hand-edited, so naming the file without naming the bad
   * field leaves them nothing to act on.
   */
  details: string;
};

export class DeserializationError extends AgentCoreCLIError {
  constructor(path: string, options: DeserializationErrorOptions) {
    const { details, ...errorOptions } = options;
    super(`Failed to deserialize file at "${path}":\n\n${details}`, {
      ...errorOptions,
      source: ERROR_SOURCE.USER,
    });
    this.name = "DeserializationError";
  }
}

/** Thrown for any project state related errors. */
export class ProjectStateError extends AgentCoreCLIError {
  constructor(message: string, options: AgentCoreCLIErrorOptions = {}) {
    super(message, {
      source: ERROR_SOURCE.USER,
      ...options,
    });
  }
}

/** Thrown when scaffolding would overwrite a file that already exists. */
export class ProjectFileExistsError extends AgentCoreCLIError {
  constructor(public readonly path: string) {
    super(`Refusing to overwrite existing file: ${path}`, {
      source: ERROR_SOURCE.USER,
      meta: { path },
    });
  }
}

/** Thrown when scaffolding would nest a new project inside an existing AgentCore project. */
export class NestedProjectError extends AgentCoreCLIError {
  constructor(public readonly projectRoot: string) {
    super(
      `cannot create a project inside an existing AgentCore project (found ${join(projectRoot, "agentcore", "agentcore.json")})`,
      { source: ERROR_SOURCE.USER, meta: { projectRoot } },
    );
  }
}

/** Thrown when an asset is missing from the compiled executable, indicating a packaging bug. */
export class EmbeddedAssetNotFoundError extends AgentCoreCLIError {
  constructor(public readonly assetPath: string) {
    super(`Embedded asset not found: ${assetPath}`, { meta: { assetPath } });
  }
}

/** Raised when a user intentionally cancels a headless CLI operation. */
export class UserCancellationError extends SilentCLIError {
  constructor() {
    super("Operation cancelled by user", {
      source: ERROR_SOURCE.USER,
      exitCode: 130,
    });
  }

  static resolve(error: unknown, signal?: AbortSignal): UserCancellationError | undefined {
    if (error instanceof UserCancellationError) return error;
    return signal?.reason instanceof UserCancellationError ? signal.reason : undefined;
  }
}

export class RuntimeInvokeResponseError extends SilentCLIError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class GatewayInvokeResponseError extends SilentCLIError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** Remote content could not be fetched, or is not available yet. */
export class NetworkingError extends AgentCoreCLIError {
  constructor(message: string, options?: AgentCoreCLIErrorOptions) {
    super(message, { source: ERROR_SOURCE.SERVICE, ...options });
  }
}

/** A CloudWatch Logs Insights query reached a terminal failure state. */
export class CloudWatchQueryError extends AgentCoreCLIError {
  constructor(message: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.SERVICE });
  }
}

/** Service data was returned successfully, but did not match the expected contract. */
export class MalformedServiceResponseError extends AgentCoreCLIError {
  constructor(message: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.SERVICE });
  }
}

/** A file could not be written locally: missing directory, permission denial, etc. */
export class FileWriteError extends AgentCoreCLIError {
  constructor(message: string, options?: AgentCoreCLIErrorOptions) {
    super(message, { source: ERROR_SOURCE.USER, ...options });
  }
}

/**
 * Thrown when a paginated read is cut short by a client-side page cap, so the
 * returned data is incomplete rather than the full result set. INTERNAL: the
 * service and the user are both fine — the limit is ours.
 */
export class ResultTruncationError extends AgentCoreCLIError {
  constructor(message: string, options?: Omit<AgentCoreCLIErrorOptions, "source">) {
    super(message, { ...options, source: ERROR_SOURCE.INTERNAL });
  }
}
