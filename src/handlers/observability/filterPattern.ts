export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_PATTERNS: Record<LogLevel, string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
};

export function buildFilterPattern(options: {
  level?: LogLevel;
  query?: string;
}): string | undefined {
  const parts: string[] = [];
  if (options.level) parts.push(LEVEL_PATTERNS[options.level]);
  if (options.query) parts.push(options.query);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
