import { AllowedScopeSchema, OidcDiscoveryUrlSchema } from "./auth";
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

export const PaymentProvisionModeSchema = z.enum(["MANUAL", "QUICK_CREATE"]);
export type PaymentProvisionMode = z.infer<typeof PaymentProvisionModeSchema>;

export const ManualPaymentConnectorSchema = z.object({
  name: PaymentConnectorNameSchema,
  provider: PaymentProviderSchema.default("CoinbaseCDP"),
  provisionMode: z.literal("MANUAL").optional(),
  credentialName: z.string().min(1),
});
export type ManualPaymentConnector = z.infer<typeof ManualPaymentConnectorSchema>;

export const QuickCreatePaymentConnectorSchema = z.object({
  name: PaymentConnectorNameSchema,
  provider: z.literal("CoinbaseCDP"),
  provisionMode: z.literal("QUICK_CREATE"),
  credentialName: z.never().optional(),
});
export type QuickCreatePaymentConnector = z.infer<typeof QuickCreatePaymentConnectorSchema>;

export const PaymentConnectorSchema = z.union([
  QuickCreatePaymentConnectorSchema,
  ManualPaymentConnectorSchema,
]);
export type PaymentConnector = z.infer<typeof PaymentConnectorSchema>;
export const PaymentManagerDescriptionSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    /^[a-zA-Z0-9\s]+$/,
    "Payment manager description must contain only alphanumeric characters and whitespace",
  );
export const PaymentSpendLimitSchema = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && Number.isFinite(Number(value)) && Number(value) >= 0,
    {
      message: "Default spend limit must be a non-negative number",
    },
  );
export const PaymentManagerSchema = z
  .object({
    name: PaymentManagerNameSchema,
    authorizerType: z.enum(["AWS_IAM", "CUSTOM_JWT"]).default("AWS_IAM"),
    authorizerConfiguration: z
      .object({
        customJWTAuthorizer: z.object({
          discoveryUrl: OidcDiscoveryUrlSchema,
          allowedClients: z.array(z.string()).min(1).optional(),
          allowedAudience: z.array(z.string()).min(1).optional(),
          allowedScopes: z.array(AllowedScopeSchema).min(1).optional(),
        }),
      })
      .optional(),
    connectors: z.array(PaymentConnectorSchema).default([]),
    description: PaymentManagerDescriptionSchema.optional(),
    autoPayment: z.boolean().default(DEFAULT_AUTO_PAYMENT),
    defaultSpendLimit: z
      .union([z.literal(""), PaymentSpendLimitSchema])
      .default(DEFAULT_SPEND_LIMIT),
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

    const connectorNames = new Set<string>();
    for (const [index, connector] of data.connectors.entries()) {
      if (connectorNames.has(connector.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate payment connector name: ${connector.name}`,
          path: ["connectors", index, "name"],
        });
      }
      connectorNames.add(connector.name);
    }
  });
export type PaymentManager = z.infer<typeof PaymentManagerSchema>;
export const PaymentAuthorizerTypeSchema = z.enum(["AWS_IAM", "CUSTOM_JWT"]);
export type PaymentAuthorizerType = z.infer<typeof PaymentAuthorizerTypeSchema>;
