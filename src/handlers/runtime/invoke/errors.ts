import { AgentCoreCLIError } from "../../../errors";

export class RuntimeInvokeInterruptedError extends AgentCoreCLIError {
  readonly reported: boolean;

  constructor(cause?: unknown, reported = false) {
    super("The operation was aborted", { cause, exitCode: 130 });
    this.name = "AbortError";
    this.reported = reported;
  }
}

export class RuntimeInvokeResponseError extends AgentCoreCLIError {
  readonly reported = true;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
