import { z } from "zod";
export const PaymentProviderSchema = z.enum(["CoinbaseCDP", "StripePrivy"]);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;
export const DEFAULT_AUTO_PAYMENT = true;
export const DEFAULT_SPEND_LIMIT = "10.00";
export const PaymentManagerNameSchema = z
  .string()
  .min(1, "Payment manager name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters (max 48 chars)",
  );
export const PaymentConnectorNameSchema = z
  .string()
  .min(1, "Payment connector name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const PaymentConnectorSchema = z.object({
  name: PaymentConnectorNameSchema,
  provider: PaymentProviderSchema.default("CoinbaseCDP"),
  credentialName: z.string().min(1),
});
export type PaymentConnector = z.infer<typeof PaymentConnectorSchema>;
export const PaymentManagerSchema = z
  .object({
    name: PaymentManagerNameSchema,
    authorizerType: z.enum(["AWS_IAM", "CUSTOM_JWT"]).default("AWS_IAM"),
    authorizerConfiguration: z
      .object({
        customJWTAuthorizer: z.object({
          discoveryUrl: z.string().url(),
          allowedClients: z.array(z.string()).optional(),
          allowedAudience: z.array(z.string()).optional(),
          allowedScopes: z.array(z.string()).optional(),
        }),
      })
      .optional(),
    connectors: z.array(PaymentConnectorSchema).default([]),
    description: z.string().optional(),
    autoPayment: z.boolean().default(DEFAULT_AUTO_PAYMENT),
    defaultSpendLimit: z.string().default(DEFAULT_SPEND_LIMIT),
    paymentToolAllowlist: z.array(z.string()).optional(),
    networkPreferences: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.authorizerType === "CUSTOM_JWT" &&
      !data.authorizerConfiguration?.customJWTAuthorizer
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "authorizerConfiguration with customJWTAuthorizer is required when authorizerType is CUSTOM_JWT",
        path: ["authorizerConfiguration"],
      });
    }
  });
export type PaymentManager = z.infer<typeof PaymentManagerSchema>;
export const PaymentAuthorizerTypeSchema = z.enum(["AWS_IAM", "CUSTOM_JWT"]);
export type PaymentAuthorizerType = z.infer<typeof PaymentAuthorizerTypeSchema>;
