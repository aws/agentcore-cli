import z from "zod";
import { PaymentProviderSchema } from "./payment";
export const CredentialNameSchema = z
  .string()
  .min(1, "Credential name is required")
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
export const ApiKeyCredentialSchema = z.object({
  authorizerType: z.literal("ApiKeyCredentialProvider"),
  name: CredentialNameSchema,
});
export type ApiKeyCredential = z.infer<typeof ApiKeyCredentialSchema>;
export const OAuthCredentialSchema = z.object({
  authorizerType: z.literal("OAuthCredentialProvider"),
  name: CredentialNameSchema,
  discoveryUrl: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  vendor: z.string().default("CustomOauth2"),
  managed: z.boolean().optional(),
  usage: z.enum(["inbound", "outbound"]).optional(),
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
