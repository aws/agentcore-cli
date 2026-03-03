const RELATIVE_DURATION_RE = /^(\d+)([smhd])$/;

const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a time string into epoch milliseconds.
 *
 * Supported formats:
 * - Relative durations: "5m", "1h", "2d", "30s"
 * - ISO 8601: "2026-03-02T14:30:00Z"
 * - Epoch milliseconds: "1709391000000"
 * - "now"
 */
export function parseTimeString(input: string): number {
  if (!input || input.trim() === '') {
    throw new Error('Time string cannot be empty');
  }

  const trimmed = input.trim();

  if (trimmed === 'now') {
    return Date.now();
  }

  // Relative duration (e.g. "5m", "1h", "2d")
  const match = RELATIVE_DURATION_RE.exec(trimmed);
  if (match) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms = UNIT_TO_MS[unit]!;
    return Date.now() - value * ms;
  }

  // Epoch milliseconds (all digits, at least 13 digits for reasonable timestamps)
  if (/^\d{13,}$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // ISO 8601
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  throw new Error(
    `Invalid time string: "${input}". Use relative durations (5m, 1h, 2d), ISO 8601, epoch ms, or "now".`
  );
}
