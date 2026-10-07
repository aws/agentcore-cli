import z from "zod";
import { InputValidationError } from "../../../../errors";
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentAuthorizerTypeSchema,
  PaymentManagerSchema,
  PaymentSpendLimitSchema,
  type PaymentAuthorizerType,
} from "../../../../projectSchemas/payment";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddResourceInput } from "../../types";
import type { AddProjectResourceConfig } from "../types";
import { addProjectResource, addDescription } from "../shared";

export type PaymentManagerInput = {
  name: string;
  authorizerType?: PaymentAuthorizerType;
  discoveryUrl?: string;
  allowedClients?: string[];
  allowedAudience?: string[];
  allowedScopes?: string[];
  description?: string;
  autoPayment?: boolean;
  defaultSpendLimit?: string;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
};

export function paymentManagerNotes(
  name: string,
  autoPayment: boolean,
  hasRuntimes: boolean,
): string[] {
  const notes: string[] = [];
  if (autoPayment) {
    notes.push(
      `Warning: auto-payment is ENABLED for manager '${name}'. Agents can automatically settle ` +
        "402 responses without human approval. Use --no-auto-payment to require manual approval.",
    );
  }
  if (hasRuntimes) {
    notes.push(
      "Warning: agentcore add payment-manager does not modify runtime source code. " +
        "Configure the Payments SDK or plugin in supported runtimes before invoking payment-enabled agents.",
    );
  }
  return notes;
}

export function toAddPaymentManagerInput(input: PaymentManagerInput): AddResourceInput {
  const authorizerType = input.authorizerType ?? "AWS_IAM";
  const jwtValues = [
    input.discoveryUrl,
    input.allowedClients,
    input.allowedAudience,
    input.allowedScopes,
  ];
  if (authorizerType === "CUSTOM_JWT" && !input.discoveryUrl) {
    throw new InputValidationError("CUSTOM_JWT requires --discovery-url");
  }
  if (authorizerType !== "CUSTOM_JWT" && jwtValues.some((value) => value !== undefined)) {
    throw new InputValidationError("JWT authorization flags are valid only with CUSTOM_JWT");
  }

  const defaultSpendLimit = input.defaultSpendLimit ?? DEFAULT_SPEND_LIMIT;
  const spendLimit = PaymentSpendLimitSchema.safeParse(defaultSpendLimit);
  if (!spendLimit.success) {
    throw new InputValidationError(z.prettifyError(spendLimit.error), {
      cause: spendLimit.error,
    });
  }

  const manager = PaymentManagerSchema.safeParse({
    name: input.name,
    authorizerType,
    authorizerConfiguration:
      authorizerType === "CUSTOM_JWT"
        ? {
            customJWTAuthorizer: {
              discoveryUrl: input.discoveryUrl!,
              allowedClients: input.allowedClients,
              allowedAudience: input.allowedAudience,
              allowedScopes: input.allowedScopes,
            },
          }
        : undefined,
    connectors: [],
    description: input.description,
    autoPayment: input.autoPayment ?? DEFAULT_AUTO_PAYMENT,
    defaultSpendLimit: spendLimit.data,
    paymentToolAllowlist: input.paymentToolAllowlist,
    networkPreferences: input.networkPreferences,
  });
  if (!manager.success) {
    throw new InputValidationError(z.prettifyError(manager.error), { cause: manager.error });
  }

  return { resourceType: "payment-manager", resourceConfig: manager.data };
}

export const createAddPaymentManagerHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "payment-manager",
    description: addDescription("payment-manager", "add a payment manager to the current project"),
    flags: [
      flag("name", "the payment manager name", z.string().min(1)),
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
        "disable automatic payment settlement",
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
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const input = toAddPaymentManagerInput({
        name: flags.name,
        authorizerType: flags["authorizer-type"],
        discoveryUrl: flags["discovery-url"],
        allowedClients: flags["allowed-clients"],
        allowedAudience: flags["allowed-audience"],
        allowedScopes: flags["allowed-scopes"],
        description: flags.description,
        autoPayment: flags["auto-payment"],
        defaultSpendLimit: flags["default-spend-limit"],
        paymentToolAllowlist: flags["tool-allowlist"],
        networkPreferences: flags["network-preferences"],
      });
      const notes = paymentManagerNotes(
        flags.name,
        flags["auto-payment"],
        project.spec.runtimes.length > 0,
      );

      await addProjectResource(
        ctx,
        config,
        project,
        input,
        `added payment manager '${flags.name}' to '${project.name}'`,
        { notes },
      );
    },
  });
