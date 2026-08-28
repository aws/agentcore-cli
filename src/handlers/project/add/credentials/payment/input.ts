import z from "zod";
import { InputValidationError } from "../../../../../errors";
import { type AppIO, SourceResolver } from "../../../../../io";
import type { PaymentProvider } from "../../../../../projectSchemas/payment";
import { flag } from "../../../../../router";
import type { EnvLocalEntry } from "../../../types";
import { credentialEnvVarName } from "../shared";
import {
  stripWalletAuthPrefix,
  validateAppSecret,
  validateApiKeySecret,
  validateAuthorizationPrivateKey,
  validatePaymentIdentifier,
  validateWalletSecret,
} from "./validation";

export const paymentCredentialInputFlags = [
  flag("api-key-id", "Coinbase CDP API key ID", z.string().optional()),
  flag(
    "api-key-secret",
    "Coinbase CDP API key secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "wallet-secret",
    "Coinbase CDP wallet secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag("app-id", "Privy application ID", z.string().optional()),
  flag(
    "app-secret",
    "Privy application secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "authorization-private-key",
    "Stripe/Privy authorization private key (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag("authorization-id", "Stripe/Privy authorization identifier", z.string().optional()),
] as const;

export type PaymentCredentialInputFlags = {
  "api-key-id"?: string;
  "api-key-secret"?: string;
  "wallet-secret"?: string;
  "app-id"?: string;
  "app-secret"?: string;
  "authorization-private-key"?: string;
  "authorization-id"?: string;
};

const COINBASE_FLAGS = ["api-key-id", "api-key-secret", "wallet-secret"] as const;
const STRIPE_FLAGS = [
  "app-id",
  "app-secret",
  "authorization-private-key",
  "authorization-id",
] as const;

export function hasPaymentCredentialInput(flags: PaymentCredentialInputFlags): boolean {
  return [...COINBASE_FLAGS, ...STRIPE_FLAGS].some((name) => flags[name] !== undefined);
}

function normalizedIdentifier(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const validation = validatePaymentIdentifier(name, normalized);
  if (validation !== true) throw new InputValidationError(validation);
  return normalized;
}

export async function resolvePaymentCredentialEnvEntries(input: {
  name: string;
  provider: PaymentProvider;
  flags: PaymentCredentialInputFlags;
  io: AppIO;
}): Promise<EnvLocalEntry[]> {
  const { name, provider, flags, io } = input;
  const invalidFlags = (provider === "CoinbaseCDP" ? STRIPE_FLAGS : COINBASE_FLAGS).filter(
    (flagName) => flags[flagName] !== undefined,
  );
  if (invalidFlags.length > 0) {
    throw new InputValidationError(
      `${invalidFlags.map((flagName) => `--${flagName}`).join(", ")} ${
        invalidFlags.length === 1 ? "is" : "are"
      } not valid with --provider ${provider}`,
    );
  }

  const resolver = new SourceResolver({ stdin: io.stdin });
  if (provider === "StripePrivy") {
    const appId = normalizedIdentifier("appId", flags["app-id"]);
    const authorizationId = normalizedIdentifier("authorizationId", flags["authorization-id"]);
    const appSecret = await resolver.resolveSecret("app-secret", flags["app-secret"]);
    if (appSecret !== undefined) {
      const validation = validateAppSecret(appSecret);
      if (validation !== true) throw new InputValidationError(validation);
    }
    const resolvedAuthorizationPrivateKey = await resolver.resolveSecret(
      "authorization-private-key",
      flags["authorization-private-key"],
    );
    const authorizationPrivateKey =
      resolvedAuthorizationPrivateKey === undefined
        ? undefined
        : stripWalletAuthPrefix(resolvedAuthorizationPrivateKey);
    if (authorizationPrivateKey !== undefined) {
      const validation = validateAuthorizationPrivateKey(authorizationPrivateKey);
      if (validation !== true) throw new InputValidationError(validation);
    }
    return [
      {
        key: credentialEnvVarName(name, "_APP_ID"),
        value: appId,
        comment: `Privy application ID for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_APP_SECRET"),
        value: appSecret,
        comment: `Privy application secret for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_AUTHORIZATION_PRIVATE_KEY"),
        value: authorizationPrivateKey,
        comment: `Stripe/Privy authorization private key for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_AUTHORIZATION_ID"),
        value: authorizationId,
        comment: `Stripe/Privy authorization ID for payment credential provider '${name}' (set before deploy)`,
      },
    ];
  }

  const apiKeyId = normalizedIdentifier("apiKeyId", flags["api-key-id"]);
  const resolvedApiKeySecret = await resolver.resolveSecret(
    "api-key-secret",
    flags["api-key-secret"],
  );
  const resolvedWalletSecret = await resolver.resolveSecret(
    "wallet-secret",
    flags["wallet-secret"],
  );
  const apiKeySecret = resolvedApiKeySecret?.trim();
  const walletSecret = resolvedWalletSecret?.trim();
  if (apiKeySecret !== undefined) {
    const validation = validateApiKeySecret(apiKeySecret);
    if (validation !== true) throw new InputValidationError(validation);
  }
  if (walletSecret !== undefined) {
    const validation = validateWalletSecret(walletSecret);
    if (validation !== true) throw new InputValidationError(validation);
  }
  return [
    {
      key: credentialEnvVarName(name, "_API_KEY_ID"),
      value: apiKeyId,
      comment: `Coinbase CDP API key ID for payment credential provider '${name}' (set before deploy)`,
    },
    {
      key: credentialEnvVarName(name, "_API_KEY_SECRET"),
      value: apiKeySecret,
      comment: `Coinbase CDP API key secret for payment credential provider '${name}' (set before deploy)`,
    },
    {
      key: credentialEnvVarName(name, "_WALLET_SECRET"),
      value: walletSecret,
      comment: `Coinbase CDP wallet secret for payment credential provider '${name}' (set before deploy)`,
    },
  ];
}
