/**
 * Client-side format validation for payment connector secrets.
 *
 * Shared by the non-interactive CLI add path (PaymentConnectorPrimitive
 * registerCommands) and the interactive TUI (AddPaymentConnectorScreen
 * SecretInput). Each validator returns `true` when valid or a human-readable
 * error string when not — the same `(value) => true | string` contract used by
 * validateBYOMountPath and the SecretInput `customValidation` prop — so both
 * surfaces reject identically instead of failing only at deploy time.
 *
 * Only fields with a server-enforced cryptographic format are validated here.
 * The opaque identifier fields (apiKeyId, appId, appSecret, authorizationId)
 * have no documented format, so they keep a non-empty check at the call site.
 */

/** Characters allowed in standard base64 (with optional `=` padding). */
const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/;

/**
 * Decoded-byte size bands for the private-key formats the payment APIs accept.
 *
 * Ed25519 (CoinbaseCDP apiKeySecret): raw seed is 32 bytes, PKCS8-wrapped ~48
 * bytes, and Coinbase's dashboard ships a 64-byte seed+public-key secret —
 * all well under the P-256 range, so Ed25519 needs its own band.
 *
 * EC P-256 (CoinbaseCDP walletSecret, StripePrivy authorizationPrivateKey):
 * PKCS8 is 138 bytes and SEC1 ~121 bytes; the 100–200 band covers both with
 * headroom and matches the previously shipped authorizationPrivateKey check.
 */
const ED25519_MIN_BYTES = 32;
const ED25519_MAX_BYTES = 64;
const P256_MIN_BYTES = 100;
const P256_MAX_BYTES = 200;

/** AWS docs ship the StripePrivy authorization key with this prefix. */
export const WALLET_AUTH_PREFIX = 'wallet-auth:';

function decodeBase64(value: string): Buffer | null {
  if (!BASE64_REGEX.test(value)) return null;
  return Buffer.from(value, 'base64');
}

/**
 * Validate the CoinbaseCDP API key secret: a base64-encoded Ed25519 private key.
 */
export function validateApiKeySecret(value: string): true | string {
  const trimmed = value.trim();
  const decoded = decodeBase64(trimmed);
  if (!decoded) {
    return 'apiKeySecret must be a base64-encoded Ed25519 private key';
  }
  if (decoded.length < ED25519_MIN_BYTES || decoded.length > ED25519_MAX_BYTES) {
    return 'apiKeySecret must be a base64-encoded Ed25519 private key (unexpected length)';
  }
  return true;
}

/**
 * Validate the CoinbaseCDP wallet secret: a base64-encoded EC P-256 private key.
 */
export function validateWalletSecret(value: string): true | string {
  const trimmed = value.trim();
  const decoded = decodeBase64(trimmed);
  if (!decoded) {
    return 'walletSecret must be a base64-encoded EC P-256 private key';
  }
  if (decoded.length < P256_MIN_BYTES || decoded.length > P256_MAX_BYTES) {
    return 'walletSecret must be a base64-encoded EC P-256 private key (unexpected length)';
  }
  return true;
}

/**
 * Strip the optional `wallet-auth:` prefix from a StripePrivy authorization
 * private key. Both the CLI and TUI normalize with this before validating and
 * persisting so the stored value is the bare base64 key.
 */
export function stripWalletAuthPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(WALLET_AUTH_PREFIX) ? trimmed.slice(WALLET_AUTH_PREFIX.length) : trimmed;
}

/**
 * Validate the StripePrivy authorization private key: a base64-encoded EC P-256
 * private key, accepting the optional `wallet-auth:` prefix.
 */
export function validateAuthorizationPrivateKey(value: string): true | string {
  const key = stripWalletAuthPrefix(value);
  const decoded = decodeBase64(key);
  if (!decoded) {
    return 'authorizationPrivateKey must be base64-encoded';
  }
  if (decoded.length < P256_MIN_BYTES || decoded.length > P256_MAX_BYTES) {
    return 'authorizationPrivateKey must be a base64-encoded EC P-256 private key (unexpected length)';
  }
  return true;
}
