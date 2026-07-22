/**
 * Available log levels ordered by severity. `SILENT` disables all output.
 */
export const LOG_LEVEL = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  SILENT: "silent",
} as const;

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

export type LoggerBindings = Record<string, unknown>;

type LogFn = (...messages: string[]) => void;

/** App-wide structured logging contract with child-logger support */
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child: (bindings: LoggerBindings) => Logger;
}

/** An extension of {@link Logger} that writes logs asynchronously and requires output to be flushed */
export interface AsyncLogger extends Logger {
  child: (bindings: LoggerBindings) => AsyncLogger;
  /** Flushes the pending logs and closes the underlying logging streams **/
  end: () => Promise<void>;
}
