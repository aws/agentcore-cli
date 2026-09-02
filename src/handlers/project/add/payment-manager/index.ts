import z from "zod";
import { InputValidationError } from "../../../../errors";
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentAuthorizerTypeSchema,
  PaymentSpendLimitSchema,
  type PaymentAuthorizerType,
  type PaymentManagerSchema,
} from "../../../../projectSchemas/payment";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";

/**
 * PaymentManagerInput is what every entry point — the flag handler, the wizard —
 * resolves its own inputs to before a payment manager is built. The JWT fields
 * are grouped, since they mean nothing apart from CUSTOM_JWT. Anything optional
 * is a field toAddPaymentManagerInput defaults.
 */
export interface PaymentManagerInput {
  name: string;
  authorizerType?: PaymentAuthorizerType;
  jwt?: {
    discoveryUrl?: string;
    allowedClients?: string[];
    allowedAudience?: string[];
    allowedScopes?: string[];
  };
  description?: string;
  autoPayment?: boolean;
  defaultSpendLimit?: string;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
}

/**
 * toAddPaymentManagerInput is the one place a payment manager is assembled from
 * user input: the authorizer defaults, the rule that JWT settings belong to
 * CUSTOM_JWT alone. Both the flag handler and the wizard call it.
 */
export function toAddPaymentManagerInput(input: PaymentManagerInput): AddResourceInput {
  const authorizerType = input.authorizerType ?? "AWS_IAM";
  const jwt = input.jwt ?? {};
  const hasJwtSettings = Object.values(jwt).some((value) => value !== undefined);

  if (authorizerType === "CUSTOM_JWT" && !jwt.discoveryUrl) {
    throw new InputValidationError("CUSTOM_JWT requires --discovery-url");
  }
  if (authorizerType !== "CUSTOM_JWT" && hasJwtSettings) {
    throw new InputValidationError("JWT authorization flags are valid only with CUSTOM_JWT");
  }

  const resourceConfig: z.input<typeof PaymentManagerSchema> = {
    name: input.name,
    authorizerType,
    authorizerConfiguration:
      authorizerType === "CUSTOM_JWT"
        ? {
            customJWTAuthorizer: {
              discoveryUrl: jwt.discoveryUrl!,
              allowedClients: jwt.allowedClients,
              allowedAudience: jwt.allowedAudience,
              allowedScopes: jwt.allowedScopes,
            },
          }
        : undefined,
    connectors: [],
    description: input.description,
    autoPayment: input.autoPayment ?? DEFAULT_AUTO_PAYMENT,
    defaultSpendLimit: input.defaultSpendLimit ?? DEFAULT_SPEND_LIMIT,
    paymentToolAllowlist: input.paymentToolAllowlist,
    networkPreferences: input.networkPreferences,
  };
  return { resourceType: "payment-manager", resourceConfig };
}

/** The warning both entry points print when a manager settles payments on its own. */
export function autoPaymentWarning(name: string): string {
  return (
    `Warning: auto-payment is ENABLED for manager '${name}'. Agents can automatically settle ` +
    "402 responses without human approval. Use --no-auto-payment to require manual approval."
  );
}

/** The warning both entry points print when the project has runtimes to configure. */
export const RUNTIME_SOURCE_WARNING =
  "Warning: project add payment-manager does not modify runtime source code. " +
  "Configure the Payments SDK or plugin in supported runtimes before invoking payment-enabled agents.";

export const createAddPaymentManagerHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "payment-manager",
    description: "adds a payment manager to the current project",
    flags: [
      flag("name", "the payment manager name", z.string().optional()),
      flag(
        "authorizer-type",
        "payment authorization type",
        PaymentAuthorizerTypeSchema.default("AWS_IAM"),
      ),
      flag(
        "discovery-url",
        "OIDC discovery URL for CUSTOM_JWT authorization",
        z.string().optional(),
      ),
      flag("allowed-clients", "allowed JWT client IDs", z.array(z.string()).optional()),
      flag("allowed-audience", "allowed JWT audiences", z.array(z.string()).optional()),
      flag("allowed-scopes", "allowed JWT scopes", z.array(z.string()).optional()),
      flag("description", "payment manager description", z.string().optional()),
      flag(
        "auto-payment",
        "automatically settle payment requests",
        z.boolean().default(DEFAULT_AUTO_PAYMENT),
      ),
      flag(
        "default-spend-limit",
        "default payment-session spend limit",
        PaymentSpendLimitSchema.default(DEFAULT_SPEND_LIMIT),
      ),
      flag(
        "tool-allowlist",
        "tools eligible for automatic payment",
        z.array(z.string()).optional(),
      ),
      flag("network-preferences", "preferred payment networks", z.array(z.string()).optional()),
    ],
    // handle only turns flags into a PaymentManagerInput. What a manager is,
    // and when JWT settings apply, belongs to toAddPaymentManagerInput.
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const input = toAddPaymentManagerInput({
        name: flags.name,
        authorizerType: flags["authorizer-type"],
        jwt: {
          discoveryUrl: flags["discovery-url"],
          allowedClients: flags["allowed-clients"],
          allowedAudience: flags["allowed-audience"],
          allowedScopes: flags["allowed-scopes"],
        },
        description: flags.description,
        autoPayment: flags["auto-payment"],
        defaultSpendLimit: flags["default-spend-limit"],
        paymentToolAllowlist: flags["tool-allowlist"],
        networkPreferences: flags["network-preferences"],
      });

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, input)) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added payment manager '${flags.name}' to '${project.name}'\n`);
      if (flags["auto-payment"]) {
        config.io.stderr.write(`${autoPaymentWarning(flags.name)}\n`);
      }
      if (project.spec.runtimes.length > 0) {
        config.io.stderr.write(`${RUNTIME_SOURCE_WARNING}\n`);
      }
    },
  });
