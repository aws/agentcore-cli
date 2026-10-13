import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ProjectStateError } from "../errors";

export const ENC_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(token: string, keys: readonly Buffer[]): string {
  if (token.startsWith(ENC_PREFIX)) {
    const raw = Buffer.from(token.slice(ENC_PREFIX.length), "base64");
    for (const key of keys) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {}
    }
  }
  throw new ProjectStateError(
    "Could not decrypt a stored secret in agentcore/.env.local. " +
      "Restore the original encryption key or re-add the credential.",
  );
}
