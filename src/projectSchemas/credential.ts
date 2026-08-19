import z from "zod";
import { PaymentProviderSchema } from "./payment";
// Min 3 keeps names inside what @aws/agentcore-cdk's ConfigIO accepts (3-255)
// so `add` never produces a spec that `build` rejects; max 128 and the character
// set are the Identity service's own limits.
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
