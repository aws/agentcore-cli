export const HEADER_ALLOWLIST_PREFIX = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-';
export const MAX_HEADER_ALLOWLIST_SIZE = 20;

/**
 * Normalize a header name according to AgentCore Runtime rules:
 * - "Authorization" (case-insensitive) -> "Authorization"
 * - Headers already starting with the prefix -> return as-is
 * - Other headers -> prepend the prefix
 */
export function normalizeHeaderName(input: string): string {
  if (input.toLowerCase() === 'authorization') {
    return 'Authorization';
  }
  if (input.startsWith(HEADER_ALLOWLIST_PREFIX)) {
    return input;
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

  // Deduplicate using Set
  return Array.from(new Set(headers));
}

/**
 * Validate a comma-separated list of header names for the allowlist.
 * Returns true if valid, or an error message string if invalid.
 * Empty/whitespace input is considered valid (field is optional).
 */
export function validateHeaderAllowlist(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed === '') {
    return true;
  }

  const headers = parseAndNormalizeHeaders(value);
  if (headers.length > MAX_HEADER_ALLOWLIST_SIZE) {
    return `Header allowlist cannot exceed ${MAX_HEADER_ALLOWLIST_SIZE} headers. Provided: ${headers.length}`;
  }

  return true;
}
