import { ServiceException } from "@smithy/core/client";
import { AgentCoreCLIError, ERROR_SOURCE } from "./types";

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
      meta: { ...error.$metadata },
    });
  }

  if (error instanceof Error) return new AgentCoreCLIError(error.message, { cause: error });

  return new AgentCoreCLIError(String(error), { cause: error });
}
