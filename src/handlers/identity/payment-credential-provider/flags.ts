import z from "zod";
import type {
  PaymentCredentialProviderVendorType,
  PaymentProviderConfigurationInput,
  SecretReference,
  SecretSourceType,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import { type AppIO, SourceResolver } from "../../../io";
import { flag } from "../../../router";
import { assertMutuallyExclusiveFlags } from "../../utils";
import { parseSecretReference } from "../parser";
import {
  stripWalletAuthPrefix,
  validateApiKeySecret,
  validateAppSecret,
  validateAuthorizationPrivateKey,
  validatePaymentIdentifier,
  validateWalletSecret,
} from "./validation";

export const PAYMENT_CREDENTIAL_PROVIDER_VENDORS = [
  "CoinbaseCDP",
  "StripePrivy",
] as const satisfies readonly PaymentCredentialProviderVendorType[];

const SECRET_SOURCE_HELP = "file://path or - for stdin; inline values are rejected";
const SECRET_REFERENCE_HELP =
  'as an external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}';

export const paymentCredentialProviderConfigFlags = [
  flag("vendor", "the payment vendor: CoinbaseCDP or StripePrivy", z.string().optional()),
  flag("api-key-id", "Coinbase CDP API key ID", z.string().optional()),
  flag(
    "api-key-secret",
    `Coinbase CDP API key secret (${SECRET_SOURCE_HELP})`,
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "api-key-secret-reference",
    `Coinbase CDP API key secret ${SECRET_REFERENCE_HELP}`,
    z.string().optional(),
  ),
  flag(
    "wallet-secret",
    `Coinbase CDP wallet secret (${SECRET_SOURCE_HELP})`,
    z.string().optional(),
    {
      sensitive: true,
    },
  ),
  flag(
    "wallet-secret-reference",
    `Coinbase CDP wallet secret ${SECRET_REFERENCE_HELP}`,
    z.string().optional(),
  ),
  flag("app-id", "Privy application ID", z.string().optional()),
  flag("app-secret", `Privy application secret (${SECRET_SOURCE_HELP})`, z.string().optional(), {
    sensitive: true,
  }),
  flag(
    "app-secret-reference",
    `Privy application secret ${SECRET_REFERENCE_HELP}`,
    z.string().optional(),
  ),
  flag("authorization-id", "Stripe/Privy authorization identifier", z.string().optional()),
  flag(
    "authorization-private-key",
    `Stripe/Privy authorization private key (${SECRET_SOURCE_HELP})`,
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "authorization-private-key-reference",
    `Stripe/Privy authorization private key ${SECRET_REFERENCE_HELP}`,
    z.string().optional(),
  ),
] as const;

export interface PaymentCredentialProviderConfigFlags {
  vendor?: string;
  "api-key-id"?: string;
  "api-key-secret"?: string;
  "api-key-secret-reference"?: string;
  "wallet-secret"?: string;
  "wallet-secret-reference"?: string;
  "app-id"?: string;
  "app-secret"?: string;
  "app-secret-reference"?: string;
  "authorization-id"?: string;
  "authorization-private-key"?: string;
  "authorization-private-key-reference"?: string;
}

type VendorFlagName = Exclude<keyof PaymentCredentialProviderConfigFlags, "vendor">;
type IdentifierFlagName = "api-key-id" | "app-id" | "authorization-id";
type SecretFlagName =
  "api-key-secret" | "wallet-secret" | "app-secret" | "authorization-private-key";

const COINBASE_FLAGS = [
  "api-key-id",
  "api-key-secret",
  "api-key-secret-reference",
  "wallet-secret",
  "wallet-secret-reference",
] as const satisfies readonly VendorFlagName[];
const STRIPE_PRIVY_FLAGS = [
  "app-id",
  "app-secret",
  "app-secret-reference",
  "authorization-id",
  "authorization-private-key",
  "authorization-private-key-reference",
] as const satisfies readonly VendorFlagName[];

export interface PaymentProviderConfiguration {
  credentialProviderVendor: PaymentCredentialProviderVendorType;
  providerConfigurationInput: PaymentProviderConfigurationInput;
}

type SecretInput =
  | { flagName: SecretFlagName; kind: "inline"; source: string }
  | { flagName: SecretFlagName; kind: "reference"; config: SecretReference };

interface ResolvedSecret {
  value?: string;
  source: SecretSourceType;
  config?: SecretReference;
}

type SecretValidator = (value: string) => true | string;

function isPaymentCredentialProviderVendor(
  value: string,
): value is PaymentCredentialProviderVendorType {
  return (PAYMENT_CREDENTIAL_PROVIDER_VENDORS as readonly string[]).includes(value);
}

// PaymentProviderConfigurationResolver turns the shared vendor flags of
// `identity payment-credential-provider create|update` into the SDK's
// providerConfigurationInput union. Shape checks (vendor, cross-vendor flags,
// identifiers, inline-versus-reference) all run before any secret is read so a
// rejected command never consumes stdin.
export class PaymentProviderConfigurationResolver {
  private readonly resolver: SourceResolver;

  constructor(
    private readonly flags: PaymentCredentialProviderConfigFlags,
    io: AppIO,
  ) {
    this.resolver = new SourceResolver({ stdin: io.stdin });
  }

  async resolve(): Promise<PaymentProviderConfiguration> {
    const vendor = this.vendor();
    this.rejectOtherVendorFlags(vendor);
    return vendor === "CoinbaseCDP" ? this.resolveCoinbaseCdp() : this.resolveStripePrivy();
  }

  private async resolveCoinbaseCdp(): Promise<PaymentProviderConfiguration> {
    const apiKeyId = this.identifier("api-key-id");
    const apiKeySecretInput = this.secretInput("api-key-secret");
    const walletSecretInput = this.secretInput("wallet-secret");
    if (this.flags["api-key-secret"] === "-" && this.flags["wallet-secret"] === "-") {
      throw new InputValidationError(
        "--api-key-secret and --wallet-secret cannot both read from stdin",
      );
    }
    const apiKeySecret = await this.secret(apiKeySecretInput, validateApiKeySecret);
    const walletSecret = await this.secret(walletSecretInput, validateWalletSecret);

    return {
      credentialProviderVendor: "CoinbaseCDP",
      providerConfigurationInput: {
        coinbaseCdpConfiguration: {
          apiKeyId,
          apiKeySecret: apiKeySecret.value,
          apiKeySecretSource: apiKeySecret.source,
          apiKeySecretConfig: apiKeySecret.config,
          walletSecret: walletSecret.value,
          walletSecretSource: walletSecret.source,
          walletSecretConfig: walletSecret.config,
        },
      },
    };
  }

  private async resolveStripePrivy(): Promise<PaymentProviderConfiguration> {
    const appId = this.identifier("app-id");
    const authorizationId = this.identifier("authorization-id");
    const appSecretInput = this.secretInput("app-secret");
    const authorizationPrivateKeyInput = this.secretInput("authorization-private-key");
    if (this.flags["app-secret"] === "-" && this.flags["authorization-private-key"] === "-") {
      throw new InputValidationError(
        "--app-secret and --authorization-private-key cannot both read from stdin",
      );
    }
    const appSecret = await this.secret(appSecretInput, validateAppSecret);
    const authorizationPrivateKey = await this.secret(
      authorizationPrivateKeyInput,
      validateAuthorizationPrivateKey,
      stripWalletAuthPrefix,
    );

    return {
      credentialProviderVendor: "StripePrivy",
      providerConfigurationInput: {
        stripePrivyConfiguration: {
          appId,
          appSecret: appSecret.value,
          appSecretSource: appSecret.source,
          appSecretConfig: appSecret.config,
          authorizationPrivateKey: authorizationPrivateKey.value,
          authorizationPrivateKeySource: authorizationPrivateKey.source,
          authorizationPrivateKeyConfig: authorizationPrivateKey.config,
          authorizationId,
        },
      },
    };
  }

  private vendor(): PaymentCredentialProviderVendorType {
    const vendor = this.flags.vendor;
    if (vendor === undefined) {
      throw new InputValidationError("required option '--vendor <vendor>' not specified");
    }
    if (!isPaymentCredentialProviderVendor(vendor)) {
      throw new InputValidationError(
        `--vendor must be one of ${PAYMENT_CREDENTIAL_PROVIDER_VENDORS.join(", ")}`,
      );
    }
    return vendor;
  }

  private rejectOtherVendorFlags(vendor: PaymentCredentialProviderVendorType): void {
    const otherVendorFlags = vendor === "CoinbaseCDP" ? STRIPE_PRIVY_FLAGS : COINBASE_FLAGS;
    const passed = otherVendorFlags.filter((flagName) => this.flags[flagName] !== undefined);
    if (passed.length === 0) return;
    throw new InputValidationError(
      `${passed.map((flagName) => `--${flagName}`).join(", ")} ${
        passed.length === 1 ? "is" : "are"
      } not valid with --vendor ${vendor}`,
    );
  }

  private identifier(flagName: IdentifierFlagName): string {
    const raw = this.flags[flagName];
    if (raw === undefined) {
      throw new InputValidationError(`required option '--${flagName} <${flagName}>' not specified`);
    }
    const value = raw.trim();
    const validation = validatePaymentIdentifier(`--${flagName}`, value);
    if (validation !== true) throw new InputValidationError(validation);
    return value;
  }

  private secretInput(flagName: SecretFlagName): SecretInput {
    const referenceFlagName = `${flagName}-reference` as const;
    const source = this.flags[flagName];
    const reference = this.flags[referenceFlagName];
    assertMutuallyExclusiveFlags(
      { [flagName]: source, [referenceFlagName]: reference },
      [flagName, referenceFlagName],
      { exactlyOne: true },
    );
    if (source !== undefined) return { flagName, kind: "inline", source };
    return {
      flagName,
      kind: "reference",
      config: parseSecretReference(referenceFlagName, reference!),
    };
  }

  private async secret(
    input: SecretInput,
    validate: SecretValidator,
    normalize: (value: string) => string = (value) => value.trim(),
  ): Promise<ResolvedSecret> {
    if (input.kind === "reference") return { source: "EXTERNAL", config: input.config };

    const value = normalize(
      (await this.resolver.resolveSecret(input.flagName, input.source)) ?? "",
    );
    if (value.length === 0) {
      throw new InputValidationError(`--${input.flagName} must not be empty`);
    }
    const validation = validate(value);
    if (validation !== true) throw new InputValidationError(validation);
    return { source: "MANAGED", value };
  }
}
