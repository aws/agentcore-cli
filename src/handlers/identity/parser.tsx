import z from "zod";
import { InputValidationError } from "../../errors";

// Requires exactly { secretId, jsonKey }, both non-empty string, no extra fields.
const secretReferenceSchema = z
  .object({
    secretId: z.string().min(1),
    jsonKey: z.string().min(1),
  })
  .strict();

export function parseSecretReference(
  flagName: string,
  raw: string,
): { secretId: string; jsonKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InputValidationError(
      `Invalid JSON for --${flagName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = secretReferenceSchema.safeParse(parsed);
  if (!result.success) {
    throw new InputValidationError(
      `--${flagName} must be a JSON object with non-empty "secretId" and "jsonKey" fields: ${result.error.message}`,
    );
  }

  return result.data;
}
