import { InputValidationError } from "../../errors";

const RELATIVE_DURATION_RE = /^(\d+)([smhd])$/;

const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseTimeString(input: string, now: () => number = Date.now): number {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new InputValidationError("Time string cannot be empty");
  }
  if (trimmed === "now") return now();

  const relative = RELATIVE_DURATION_RE.exec(trimmed);
  if (relative) {
    return now() - parseInt(relative[1]!, 10) * UNIT_TO_MS[relative[2]!]!;
  }
  if (/^\d{13,}$/.test(trimmed)) return parseInt(trimmed, 10);

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) return timestamp;

  throw new InputValidationError(
    `Invalid time string: "${input}". Use relative durations (5m, 1h, 2d), ` +
      'ISO 8601, epoch ms, or "now".',
  );
}

export function resolveTimeWindow(
  input: {
    since?: string;
    until?: string;
    defaultWindowMs: number;
  },
  now: () => number = Date.now,
): { startTimeMs: number; endTimeMs: number } {
  const referenceTime = now();
  const parse = (value: string) => parseTimeString(value, () => referenceTime);
  const endTimeMs = input.until === undefined ? referenceTime : parse(input.until);
  const startTimeMs =
    input.since === undefined ? endTimeMs - input.defaultWindowMs : parse(input.since);
  if (startTimeMs > endTimeMs) {
    throw new InputValidationError("--since must resolve to a time before --until");
  }
  return { startTimeMs, endTimeMs };
}
