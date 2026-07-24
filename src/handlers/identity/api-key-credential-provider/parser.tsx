// Requires exactly { secretId, jsonKey } with non-empty string values.
export function parseSecretReference(raw: string): { secretId: string; jsonKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `Invalid JSON for --api-key-secret-reference: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(
      '--api-key-secret-reference must be a JSON object with "secretId" and "jsonKey"',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["secretId", "jsonKey"]);
  const unexpected = Object.keys(obj).filter((k) => !allowedKeys.has(k));
  if (unexpected.length > 0) {
    throw new TypeError(
      `--api-key-secret-reference contains unexpected fields: ${unexpected.join(", ")}`,
    );
  }

  if (typeof obj.secretId !== "string" || obj.secretId.length === 0) {
    throw new TypeError('--api-key-secret-reference requires a non-empty "secretId" string');
  }
  if (typeof obj.jsonKey !== "string" || obj.jsonKey.length === 0) {
    throw new TypeError('--api-key-secret-reference requires a non-empty "jsonKey" string');
  }

  return { secretId: obj.secretId, jsonKey: obj.jsonKey };
}
