import z from "zod";
import { InputValidationError } from "../../../../errors";
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentAuthorizerTypeSchema,
  PaymentSpendLimitSchema,
} from "../../../../projectSchemas/payment";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";

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
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const jwtFlags = [
        flags["discovery-url"],
        flags["allowed-clients"],
        flags["allowed-audience"],
        flags["allowed-scopes"],
      ];
      if (flags["authorizer-type"] === "CUSTOM_JWT" && !flags["discovery-url"]) {
        throw new InputValidationError("CUSTOM_JWT requires --discovery-url");
      }
      if (
        flags["authorizer-type"] !== "CUSTOM_JWT" &&
        jwtFlags.some((value) => value !== undefined)
      ) {
        throw new InputValidationError("JWT authorization flags are valid only with CUSTOM_JWT");
      }

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "payment-manager",
        resourceConfig: {
          name: flags.name,
          authorizerType: flags["authorizer-type"],
          authorizerConfiguration:
            flags["authorizer-type"] === "CUSTOM_JWT"
              ? {
                  customJWTAuthorizer: {
                    discoveryUrl: flags["discovery-url"]!,
                    allowedClients: flags["allowed-clients"],
                    allowedAudience: flags["allowed-audience"],
                    allowedScopes: flags["allowed-scopes"],
                  },
                }
              : undefined,
          connectors: [],
          description: flags.description,
          autoPayment: flags["auto-payment"],
          defaultSpendLimit: flags["default-spend-limit"],
          paymentToolAllowlist: flags["tool-allowlist"],
          networkPreferences: flags["network-preferences"],
        },
      })) {
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added payment manager '${flags.name}' to '${project.name}'\n`);
      if (flags["auto-payment"]) {
        config.io.stderr.write(
          `Warning: auto-payment is ENABLED for manager '${flags.name}'. Agents can automatically settle ` +
            "402 responses without human approval. Use --no-auto-payment to require manual approval.\n",
        );
      }
      if (project.spec.runtimes.length > 0) {
        config.io.stderr.write(
          "Warning: project add payment-manager does not modify runtime source code. " +
            "Configure the Payments SDK or plugin in supported runtimes before invoking payment-enabled agents.\n",
        );
      }
    },
  });
