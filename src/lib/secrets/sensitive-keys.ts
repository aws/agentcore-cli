/**
 * Single source of truth for "is this env value a secret that must be encrypted
 * at rest." Used by env.ts on write/read; extend with one entry when a new
 * secret-bearing credential field is introduced anywhere in the CLI.
 */

/** Suffixes whose values are secrets. */
const SECRET_SUFFIXES = [
  '_API_KEY_SECRET',
  '_WALLET_SECRET',
  '_AUTHORIZATION_PRIVATE_KEY',
  '_APP_SECRET',
  '_CLIENT_SECRET',
  '_API_KEY',
];

/** Reference/identifier suffixes that are NOT secrets (stay readable). */
const REFERENCE_SUFFIXES = ['_API_KEY_ID', '_APP_ID', '_CLIENT_ID', '_AUTHORIZATION_ID'];

export const SENSITIVE_KEY_PATTERNS: RegExp[] = SECRET_SUFFIXES.map(s => new RegExp(`${s}$`));

/**
 * Model-provider API keys are stored as the bare `AGENTCORE_CREDENTIAL_<NAME>`
 * (no secret suffix). Treat such a credential var as a secret UNLESS it ends in
 * a known reference suffix.
 */
function isBareModelCredential(key: string): boolean {
  if (!key.startsWith('AGENTCORE_CREDENTIAL_')) return false;
  return !REFERENCE_SUFFIXES.some(suffix => key.endsWith(suffix));
}

export function isSensitiveKey(key: string): boolean {
  if (REFERENCE_SUFFIXES.some(suffix => key.endsWith(suffix))) return false;
  if (SENSITIVE_KEY_PATTERNS.some(re => re.test(key))) return true;
  return isBareModelCredential(key);
}

/**
 * Normalize a credential name into its env-var-suffix form (matches
 * computeDefaultCredentialEnvVarName: hyphens → underscores, uppercased).
 */
function normalizeCredentialNameToKey(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

/**
 * Validate that an API-key credential NAME won't collide with a reserved
 * reference suffix. A bare API-key credential is stored as
 * `AGENTCORE_CREDENTIAL_<NAME>` carrying the secret value directly; if <NAME>
 * normalizes to end in a reference suffix (e.g. `my-client-id` → `..._CLIENT_ID`)
 * the value is indistinguishable from a non-secret reference and would be left
 * UNENCRYPTED at rest. Reject such names at creation (fail closed).
 *
 * Returns `true` if the name is safe, or an error message string if not — the
 * `(value) => true | string` contract used by both the CLI and the TUI's
 * SecretInput/TextInput `customValidation`.
 */
export function validateCredentialNameEncryptable(name: string): true | string {
  const normalized = normalizeCredentialNameToKey(name);
  const collision = REFERENCE_SUFFIXES.find(suffix => normalized.endsWith(suffix));
  if (collision) {
    return `Credential name "${name}" ends in a reserved reference suffix (${collision}) and its secret would not be encrypted at rest. Choose a name that does not end in id/client-id/app-id/authorization-id.`;
  }
  return true;
}
