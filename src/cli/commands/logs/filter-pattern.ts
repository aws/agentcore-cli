const LEVEL_MAP: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
};

export const VALID_LEVELS = Object.keys(LEVEL_MAP);

/**
 * Build a CloudWatch Logs filter pattern from level and query options.
 *
 * Level maps to uppercase text (e.g. "error" -> "ERROR").
 * Query is passed through as-is.
 * Both are combined with a space (implicit AND in CloudWatch filter patterns).
 */
export function buildFilterPattern(options: { level?: string; query?: string }): string | undefined {
  const parts: string[] = [];

  if (options.level) {
    const mapped = LEVEL_MAP[options.level.toLowerCase()];
    if (!mapped) {
      throw new Error(`Invalid log level: "${options.level}". Valid levels: ${VALID_LEVELS.join(', ')}`);
    }
    parts.push(mapped);
  }

  if (options.query) {
    parts.push(options.query);
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}
