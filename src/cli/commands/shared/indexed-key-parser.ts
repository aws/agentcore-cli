import type { IndexedKey, IndexedKeyType } from '../../../schema';
import {
  INDEXED_KEY_NAME_PATTERN,
  INDEXED_KEY_NAME_PATTERN_MESSAGE,
  IndexedKeyTypeSchema,
  MAX_INDEXED_KEYS,
  MAX_INDEXED_KEY_NAME_LENGTH,
} from '../../../schema';

export { INDEXED_KEY_NAME_PATTERN, MAX_INDEXED_KEYS };
export const MAX_KEY_NAME_LENGTH = MAX_INDEXED_KEY_NAME_LENGTH;
export const VALID_INDEXED_KEY_TYPES: readonly IndexedKeyType[] = ['STRING', 'STRINGLIST', 'NUMBER'];

/**
 * Validate an indexed key name. Returns `true` when valid, or an error message.
 * Shared between the schema-side regex (via constants) and TUI inline validation.
 */
export function validateIndexedKeyName(value: string, existingNames: readonly string[] = []): true | string {
  if (!INDEXED_KEY_NAME_PATTERN.test(value)) {
    return INDEXED_KEY_NAME_PATTERN_MESSAGE;
  }
  if (value.trim().length === 0) {
    return 'Key cannot be only whitespace';
  }
  if (value.length > MAX_INDEXED_KEY_NAME_LENGTH) {
    return `Maximum ${MAX_INDEXED_KEY_NAME_LENGTH} characters`;
  }
  if (existingNames.includes(value)) {
    return 'Key already defined';
  }
  return true;
}

export interface IndexedKeyParseError {
  ok: false;
  error: string;
}

export interface IndexedKeyParseSuccess {
  ok: true;
  value: IndexedKey;
}

export type IndexedKeyParseResult = IndexedKeyParseError | IndexedKeyParseSuccess;

/**
 * Parse a single `key:TYPE` argument into a validated IndexedKey.
 *
 * Splits on the *last* `:` so that key names may contain `:` (the AgentCore
 * service accepts `:` in indexed key names; type tokens never do).
 */
export function parseIndexedKeyArg(raw: string): IndexedKeyParseResult {
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx === -1) {
    return { ok: false, error: `Invalid indexed key format: "${raw}". Expected key:TYPE (e.g. priority:NUMBER)` };
  }
  const key = raw.slice(0, colonIdx);
  const typeToken = raw.slice(colonIdx + 1).toUpperCase();

  if (!key) {
    return { ok: false, error: `Invalid indexed key format: "${raw}". Key name cannot be empty` };
  }
  if (key.length > MAX_KEY_NAME_LENGTH) {
    return {
      ok: false,
      error: `Indexed key name "${key}" exceeds maximum length of ${MAX_KEY_NAME_LENGTH} characters`,
    };
  }
  if (!INDEXED_KEY_NAME_PATTERN.test(key)) {
    return {
      ok: false,
      error: `Invalid indexed key name "${key}". Must contain only alphanumeric characters, whitespace, or the symbols . _ : / = + @ -`,
    };
  }
  if (key.trim().length === 0) {
    return { ok: false, error: `Invalid indexed key name "${key}". Key cannot be only whitespace` };
  }
  const parsedType = IndexedKeyTypeSchema.safeParse(typeToken);
  if (!parsedType.success) {
    return {
      ok: false,
      error: `Invalid type "${typeToken}" for indexed key "${key}". Must be one of: ${VALID_INDEXED_KEY_TYPES.join(', ')}`,
    };
  }
  return { ok: true, value: { key, type: parsedType.data } };
}
