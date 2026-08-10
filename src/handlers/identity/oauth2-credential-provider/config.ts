import type {
  CredentialProviderVendorType,
  CustomOauth2ProviderConfigInput,
  CustomOauth2ProviderConfigOutput,
  Oauth2AuthorizationServerMetadata,
  Oauth2Discovery,
  Oauth2ProviderConfigInput,
  SecretReference,
  SecretSourceType,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import { parseJsonFlag } from "../../utils";

export type ProviderConfigMode =
  | {
      kind: "complete";
      config: Record<string, unknown>;
      configKey: string;
      vendorConfig: Record<string, unknown>;
    }
  | {
      kind: "guided";
      clientId?: string;
      oauthDiscovery?: Oauth2Discovery;
    };

interface ProviderConfigFlags {
  clientId?: string;
  discoveryUrl?: string;
  authorizationServerMetadata?: string;
  providerConfiguration?: string;
}

interface SecretUpdate {
  clientSecret?: string;
  clientSecretConfig?: SecretReference;
  clientSecretSource?: SecretSourceType;
}

interface BuildProviderConfigOptions {
  existingCustomConfig?: CustomOauth2ProviderConfigOutput;
  secret: SecretUpdate;
}

export function parseProviderConfigFlags(flags: ProviderConfigFlags): ProviderConfigMode {
  const hasProviderConfig = flags.providerConfiguration !== undefined;
  const hasDiscoveryUrl = flags.discoveryUrl !== undefined;
  const hasAuthServerMetadata = flags.authorizationServerMetadata !== undefined;
  const hasGuidedFlags = flags.clientId !== undefined || hasDiscoveryUrl || hasAuthServerMetadata;

  // Complete and guided inputs represent separate configuration modes.
  if (hasProviderConfig && hasGuidedFlags) {
    throw new InputValidationError(
      "--provider-configuration and guided flags (--client-id, --discovery-url, --authorization-server-metadata) are mutually exclusive",
    );
  }
  // OAuth discovery is a union, so only one discovery form can be supplied.
  if (hasDiscoveryUrl && hasAuthServerMetadata) {
    throw new InputValidationError(
      "--discovery-url and --authorization-server-metadata are mutually exclusive",
    );
  }

  if (flags.providerConfiguration !== undefined) {
    const parsed = parseJsonFlag<unknown>("provider-configuration", flags.providerConfiguration)!;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new InputValidationError(
        "--provider-configuration must contain a single vendor config object",
      );
    }

    const config = parsed as Record<string, unknown>;
    const entries = Object.entries(config);
    const [configKey, vendorConfig] = entries[0] ?? [];
    if (
      entries.length !== 1 ||
      !configKey ||
      typeof vendorConfig !== "object" ||
      vendorConfig === null ||
      Array.isArray(vendorConfig)
    ) {
      throw new InputValidationError(
        "--provider-configuration must contain a single vendor config object",
      );
    }

    return {
      kind: "complete",
      config,
      configKey,
      vendorConfig: vendorConfig as Record<string, unknown>,
    };
  }

  const authorizationServerMetadata = parseJsonFlag<Oauth2AuthorizationServerMetadata>(
    "authorization-server-metadata",
    flags.authorizationServerMetadata,
  );
  const oauthDiscovery: Oauth2Discovery | undefined =
    flags.discoveryUrl !== undefined
      ? { discoveryUrl: flags.discoveryUrl }
      : authorizationServerMetadata
        ? { authorizationServerMetadata }
        : undefined;

  return {
    kind: "guided",
    clientId: flags.clientId,
    oauthDiscovery,
  };
}

export function validateProviderConfigMode(
  mode: ProviderConfigMode,
  vendor: CredentialProviderVendorType,
  existingCustomConfig?: CustomOauth2ProviderConfigOutput,
): void {
  if (mode.kind === "complete") {
    return;
  }

  // Guided flags only describe the custom OAuth2 configuration shape.
  if (vendor !== "CustomOauth2") {
    throw new InputValidationError(
      `--provider-configuration is required for --vendor ${vendor}; guided flags only support CustomOauth2`,
    );
  }
  // Create must supply discovery; update may retain it from the existing config.
  if (mode.oauthDiscovery === undefined && existingCustomConfig?.oauthDiscovery === undefined) {
    throw new InputValidationError(
      "guided --vendor CustomOauth2 requires one of --discovery-url or --authorization-server-metadata",
    );
  }
}

export function buildProviderConfigInput(
  mode: ProviderConfigMode,
  { existingCustomConfig, secret }: BuildProviderConfigOptions,
): Oauth2ProviderConfigInput {
  if (mode.kind === "complete") {
    // Complete mode replaces the vendor config after injecting the secret.
    return {
      ...mode.config,
      [mode.configKey]: {
        ...mode.vendorConfig,
        ...secret,
      },
    } as unknown as Oauth2ProviderConfigInput;
  }

  // Existing config is the merge base for guided updates and absent on create.
  const customConfig: CustomOauth2ProviderConfigInput = {
    ...existingCustomConfig,
    ...secret,
    oauthDiscovery: mode.oauthDiscovery ?? existingCustomConfig?.oauthDiscovery,
    ...(mode.clientId !== undefined && { clientId: mode.clientId }),
  };
  return { customOauth2ProviderConfig: customConfig };
}
