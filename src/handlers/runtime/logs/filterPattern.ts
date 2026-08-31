// CloudWatch Logs filter-pattern assembly for `runtime logs`, ported from the
// old CLI's src/cli/commands/logs/filter-pattern.ts.

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// Runtime log lines embed their level as uppercase text (ERROR, WARN, ...), so
// a level filter is just that token in the pattern.
const LEVEL_MAP: Record<LogLevel, string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
};

/**
 * Builds a CloudWatch Logs filter pattern from the --level and --query options.
 * The level maps to its uppercase token; the query passes through as-is; both
 * combine with a space, which CloudWatch treats as an implicit AND. Returns
 * undefined when neither is set (no server-side filtering).
 */
export function buildFilterPattern(options: {
  level?: LogLevel;
  query?: string;
}): string | undefined {
  const parts: string[] = [];
  if (options.level) parts.push(LEVEL_MAP[options.level]);
  if (options.query) parts.push(options.query);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
