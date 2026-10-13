import {
  CREDENTIAL_ENV_PREFIX,
  CREDENTIAL_REFERENCE_SUFFIXES,
  CREDENTIAL_SECRET_SUFFIXES,
} from "../projectSchemas/credential";

export function isSensitiveKey(key: string): boolean {
  if (CREDENTIAL_REFERENCE_SUFFIXES.some((suffix) => key.endsWith(suffix))) return false;
  return (
    key.endsWith("_API_KEY") ||
    CREDENTIAL_SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix)) ||
    key.startsWith(CREDENTIAL_ENV_PREFIX)
  );
}
