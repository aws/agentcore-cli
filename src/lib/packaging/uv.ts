import type { SubprocessResult } from '../utils/subprocess';

export interface PlatformIssue {
  message: string;
  platforms?: string[];
}

const PLATFORM_HINT_REGEX = /platforms:\s*([^\n]+)/i;
const MANYLINUX_TOKEN = /(manylinux[^\s,]+)/gi;
const NO_WHEELS_REGEX =
  /(has no wheels with a matching (?:platform|Python ABI) tag|no compatible (?:wheels|tags) found|has no usable wheels)/i;

export function detectUnavailablePlatform(result: SubprocessResult): PlatformIssue | null {
  const combined = `${result.stdout}\n${result.stderr}`;
  const hintMatch = PLATFORM_HINT_REGEX.exec(combined);
  if (hintMatch?.[1]) {
    const hints = Array.from(hintMatch[1].matchAll(MANYLINUX_TOKEN))
      .map(match => match[1])
      .filter((value): value is string => Boolean(value));
    if (hints.length > 0) {
      return {
        message: extractRelevantBlock(combined, PLATFORM_HINT_REGEX),
        platforms: hints,
      };
    }
  }

  if (NO_WHEELS_REGEX.test(combined)) {
    return { message: extractRelevantBlock(combined, NO_WHEELS_REGEX) };
  }

  return null;
}

function extractRelevantBlock(text: string, pattern: RegExp, context = 3): string {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => pattern.test(line));
  if (index === -1) {
    return text.trim();
  }
  const start = Math.max(0, index - context);
  const end = Math.min(lines.length, index + context + 1);
  return lines
    .slice(start, end)
    .map(line => line.trim())
    .join('\n')
    .trim();
}
