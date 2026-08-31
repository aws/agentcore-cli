import z from "zod";
import { PaymentProviderSchema } from "./payment";
// Max length and character set are the Identity service's own limits. The min
// is temporarily raised above 1 so `add` never produces a name that the pinned
// @aws/agentcore-cdk rejects at `build`; drop it back to 1 once a release that
// aligns the two ships. See credentials-add-followups.
export const CredentialNameSchema = z
  .string()
  .min(3, "Credential name must be at least 3 characters")
  .max(128, "Credential name must be 128 characters or less")
  .regex(
    /^[a-zA-Z0-9\-_]+$/,
    "Must contain only alphanumeric characters, hyphens, and underscores (1-128 chars)",
  );
export const CredentialTypeSchema = z.enum([
  "ApiKeyCredentialProvider",
  "OAuthCredentialProvider",
  "PaymentCredentialProvider",
]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;
/** A reference to a secret the customer already keeps in AWS Secrets Manager. */
export const SecretReferenceSchema = z
  .object({
    secretId: z.string().min(1),
    jsonKey: z.string().min(1),
  })
  .strict();
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
export const ApiKeyCredentialSchema = z.object({
  authorizerType: z.literal("ApiKeyCredentialProvider"),
  name: CredentialNameSchema,
  /** External Secrets Manager reference; when absent the key comes from .env.local. */
  secretRef: SecretReferenceSchema.optional(),
});
export type ApiKeyCredential = z.infer<typeof ApiKeyCredentialSchema>;
const CUSTOM_OAUTH_VENDOR = "CustomOauth2";
// Secret values never belong in agentcore.json; they travel via .env.local or
// Secrets Manager references. These key names match the SDK's inline-secret fields.
const SECRET_MATERIAL_KEYS = new Set(["clientSecret", "apiKey"]);
function findSecretMaterialKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_MATERIAL_KEYS.has(key)) return key;
    const found = findSecretMaterialKey(nested);
    if (found) return found;
  }
  return undefined;
}
export const OAuthCredentialSchema = z
  .object({
    authorizerType: z.literal("OAuthCredentialProvider"),
    name: CredentialNameSchema,
    /** Credential provider vendor (free-form to track the service without CLI releases). */
    vendor: z.string().default(CUSTOM_OAUTH_VENDOR),
    /** Guided custom OAuth fields. */
    clientId: z.string().optional(),
    discoveryUrl: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
    /** Complete Oauth2ProviderConfigInput (secret-free) for vendored providers. */
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    /** External Secrets Manager reference; when absent the secret comes from .env.local. */
    clientSecretRef: SecretReferenceSchema.optional(),
    /** Whether this credential was auto-created by the CLI (e.g. for CUSTOM_JWT inbound auth). */
    managed: z.boolean().optional(),
  })
  .superRefine((credential, ctx) => {
    const hasGuidedFields =
      credential.clientId !== undefined ||
      credential.discoveryUrl !== undefined ||
      credential.scopes !== undefined;
    if (credential.providerConfig !== undefined && hasGuidedFields) {
      ctx.addIssue({
        code: "custom",
        message:
          "providerConfig and the guided fields (clientId, discoveryUrl, scopes) are mutually exclusive",
      });
      return;
    }
    if (credential.providerConfig === undefined) {
      if (credential.vendor !== CUSTOM_OAUTH_VENDOR) {
        ctx.addIssue({
          code: "custom",
          message: `vendor "${credential.vendor}" requires providerConfig; guided fields only support ${CUSTOM_OAUTH_VENDOR}`,
        });
      } else if (credential.discoveryUrl === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `guided ${CUSTOM_OAUTH_VENDOR} requires discoveryUrl`,
        });
      }
      return;
    }
    const secretKey = findSecretMaterialKey(credential.providerConfig);
    if (secretKey) {
      ctx.addIssue({
        code: "custom",
        message:
          `providerConfig must not contain secret material (found "${secretKey}"). ` +
          "Provide secrets via --client-secret, a secret reference, or .env.local.",
      });
    }
  });
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;
export const PaymentCredentialSchema = z.object({
  authorizerType: z.literal("PaymentCredentialProvider"),
  name: CredentialNameSchema,
  provider: PaymentProviderSchema,
});
export type PaymentCredential = z.infer<typeof PaymentCredentialSchema>;
export const CredentialSchema = z.discriminatedUnion("authorizerType", [
  ApiKeyCredentialSchema,
  OAuthCredentialSchema,
  PaymentCredentialSchema,
]);
export type Credential = z.infer<typeof CredentialSchema>;

/** The prefix every variable carrying credential material shares. */
export const CREDENTIAL_ENV_PREFIX = "AGENTCORE_CREDENTIAL_";

/** Derives the .env.local variable name used for credential material. */
export function credentialEnvVarName(credentialName: string, suffix = ""): string {
  return `${CREDENTIAL_ENV_PREFIX}${credentialName.replace(/-/g, "_").toUpperCase()}${suffix}`;
}

/**
 * The suffixes the CLI appends to a credential's base variable to name one of its
 * fields — both the secret-bearing ones and the readable identifiers.
 */
const CREDENTIAL_FIELD_SUFFIXES = [
  "_CLIENT_SECRET",
  "_API_KEY_SECRET",
  "_APP_SECRET",
  "_WALLET_SECRET",
  "_AUTHORIZATION_PRIVATE_KEY",
  // Identifiers rather than secrets. `_CLIENT_ID` is no longer written — an OAuth
  // client id lives in agentcore.json — but deploy still reads it for projects
  // created before that move, so a name that produces it is still a hazard.
  "_CLIENT_ID",
  "_API_KEY_ID",
  "_APP_ID",
  "_AUTHORIZATION_ID",
] as const;

/**
 * Reports the field suffix a credential name ends in, if any.
 *
 * A credential named `svc_client_id` derives `AGENTCORE_CREDENTIAL_SVC_CLIENT_ID`,
 * which is indistinguishable from the client id of an OAuth credential named `svc`.
 * Rejecting such a name at creation fails closed: the collision check in
 * {@link credentialEnvironmentVariableNames} only sees fields a credential currently
 * writes, so it cannot catch a clash with a field written by an older CLI or added
 * by a later one.
 */
export function credentialNameFieldSuffix(credentialName: string): string | undefined {
  const normalized = credentialName.replace(/-/g, "_").toUpperCase();
  return CREDENTIAL_FIELD_SUFFIXES.find((suffix) => normalized.endsWith(suffix));
}

/** Returns every .env.local key a credential reserves when it does not use an external secret. */
export function credentialEnvironmentVariableNames(credential: Credential): string[] {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return credential.secretRef ? [] : [credentialEnvVarName(credential.name)];
    case "OAuthCredentialProvider":
      return credential.clientSecretRef
        ? []
        : [credentialEnvVarName(credential.name, "_CLIENT_SECRET")];
    case "PaymentCredentialProvider": {
      const suffixes =
        credential.provider === "CoinbaseCDP"
          ? ["_API_KEY_ID", "_API_KEY_SECRET", "_WALLET_SECRET"]
          : ["_APP_ID", "_APP_SECRET", "_AUTHORIZATION_PRIVATE_KEY", "_AUTHORIZATION_ID"];
      return suffixes.map((suffix) => credentialEnvVarName(credential.name, suffix));
    }
  }
}
