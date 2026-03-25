import {
  HEADER_ALLOWLIST_PREFIX as HEADER_ALLOWLIST_PREFIX_FROM_SCHEMA,
  MAX_HEADER_ALLOWLIST_SIZE as MAX_HEADER_ALLOWLIST_SIZE_FROM_SCHEMA,
} from '../../../schema/schemas/agent-env';

export const HEADER_ALLOWLIST_PREFIX = HEADER_ALLOWLIST_PREFIX_FROM_SCHEMA;
export const MAX_HEADER_ALLOWLIST_SIZE = MAX_HEADER_ALLOWLIST_SIZE_FROM_SCHEMA;

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Normalize a header name according to AgentCore Runtime rules:
 * - "Authorization" (case-insensitive) -> "Authorization"
 * - Headers already starting with the prefix (case-insensitive) -> canonical prefix + original suffix
 * - Other headers -> prepend the prefix
 */
export function normalizeHeaderName(input: string): string {
  if (input.toLowerCase() === 'authorization') {
    return 'Authorization';
  }
  if (input.toLowerCase().startsWith(HEADER_ALLOWLIST_PREFIX.toLowerCase())) {
    return `${HEADER_ALLOWLIST_PREFIX}${input.slice(HEADER_ALLOWLIST_PREFIX.length)}`;
  }
  return `${HEADER_ALLOWLIST_PREFIX}${input}`;
}

/**
 * Parse a comma-separated string of header names, normalize each, and deduplicate.
 * Returns an array of normalized header names.
 */
export function parseAndNormalizeHeaders(input: string): string[] {
  const headers = input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeHeaderName);

  return Array.from(new Set(headers));
}

/**
 * Validate a comma-separated list of header names for the allowlist.
 * Empty/whitespace input is considered valid (field is optional).
 */
export function validateHeaderAllowlist(value: string): { success: boolean; error?: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { success: true };
  }

  const rawNames = trimmed
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const name of rawNames) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      return {
        success: false,
        error: `Invalid header name "${name}". Header names may only contain letters, numbers, and hyphens.`,
      };
    }
  }

  const headers = parseAndNormalizeHeaders(value);
  if (headers.length > MAX_HEADER_ALLOWLIST_SIZE) {
    return {
      success: false,
      error: `Header allowlist cannot exceed ${MAX_HEADER_ALLOWLIST_SIZE} headers. Provided: ${headers.length}`,
    };
  }

  return { success: true };
}

/**
 * Parse a CLI --header flag value ("Key: Value" or "Key:Value") into a key-value pair.
 * The header name is normalized according to AgentCore Runtime rules.
 * Returns null if the format is invalid.
 */
export function parseHeaderFlag(raw: string): { name: string; value: string } | null {
  const colonIndex = raw.indexOf(':');
  if (colonIndex < 1) return null;

  const name = raw.slice(0, colonIndex).trim();
  const value = raw.slice(colonIndex + 1).trim();

  if (!name) return null;

  return { name: normalizeHeaderName(name), value };
}

/**
 * Parse multiple --header flag values into a Record<string, string>.
 * Normalizes header names and deduplicates (last value wins).
 */
export function parseHeaderFlags(rawHeaders: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const raw of rawHeaders) {
    const parsed = parseHeaderFlag(raw);
    if (!parsed) {
      throw new Error(`Invalid header format: "${raw}". Expected "Header-Name: value" or "Header-Name:value".`);
    }
    result[parsed.name] = parsed.value;
  }

  return result;
}
