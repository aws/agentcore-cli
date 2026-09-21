type LogMethod = (...messages: unknown[]) => void;

export type TestLogger = {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
};

/** Given a scope, creates a thin console-backed logger for E2E diagnostics. */
export function createLogger(scope: string): TestLogger {
  const write = (method: (...messages: unknown[]) => void): LogMethod => {
    return (...messages) => method(`[${scope}]`, ...messages);
  };

  return {
    debug: write(console.debug),
    info: write(console.info),
    warn: write(console.warn),
    error: write(console.error),
  };
}
