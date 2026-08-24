import z from "zod";
import type { Oauth2ProviderConfigOutput } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { coreOptsFromCtx } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";
import {
  buildProviderConfigInput,
  parseProviderConfigFlags,
  type ProviderConfigMode,
  validateProviderConfigMode,
} from "../config";

function validateCompleteConfigKey(
  mode: ProviderConfigMode,
  existingProviderConfig: Oauth2ProviderConfigOutput | undefined,
): void {
  if (mode.kind !== "complete") {
    return;
  }

  const existingConfigKey = existingProviderConfig
    ? Object.keys(existingProviderConfig)[0]
    : undefined;
  if (!existingConfigKey || existingConfigKey === "$unknown") {
    throw new InputValidationError("existing provider is missing a supported configuration");
  }
  if (mode.configKey !== existingConfigKey) {
    throw new InputValidationError(
      `--provider-configuration must use "${existingConfigKey}", received "${mode.configKey}"`,
    );
  }
}

export const createUpdateOauth2CredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an OAuth2 credential provider",
    flags: [
      flag("name", "the name of the OAuth2 credential provider", z.string().optional()),
      flag("vendor", "the OAuth2 vendor", z.string().optional()),
      flag(
        "client-secret",
        "the client secret (file://path or - for stdin; inline values are rejected)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "client-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
      flag("client-id", "OAuth2 client ID (guided Custom OAuth2)", z.string().optional()),
      flag("discovery-url", "OAuth2 discovery URL (guided Custom OAuth2)", z.string().optional()),
      flag(
        "authorization-server-metadata",
        "authorization server metadata JSON (guided Custom OAuth2)",
        z.string().optional(),
      ),
      flag(
        "provider-configuration",
        "complete OAuth2 provider configuration JSON (alternative to guided flags)",
        z.string().optional(),
        { sensitive: true },
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const hasClientSecret = flags["client-secret"] !== undefined;
      const hasSecretRef = flags["client-secret-reference"] !== undefined;

      if (hasClientSecret && hasSecretRef) {
        throw new InputValidationError(
          "--client-secret and --client-secret-reference are mutually exclusive",
        );
      }
      if (!hasClientSecret && !hasSecretRef) {
        throw new InputValidationError(
          "either --client-secret or --client-secret-reference is required",
        );
      }

      const providerConfigMode = parseProviderConfigFlags({
        clientId: flags["client-id"],
        discoveryUrl: flags["discovery-url"],
        authorizationServerMetadata: flags["authorization-server-metadata"],
        providerConfiguration: flags["provider-configuration"],
      });

      const opts = coreOptsFromCtx(ctx);
      const existing = await core.identity.getOauth2CredentialProvider(flags.name, opts);

      // The vendor is required as an update discriminator but cannot be changed.
      const vendor = existing.credentialProviderVendor;
      if (!vendor) {
        throw new InputValidationError("existing provider is missing its vendor");
      }
      if (flags.vendor !== undefined && flags.vendor !== vendor) {
        throw new InputValidationError(
          `--vendor cannot be changed during update: provider uses ${vendor}, received ${flags.vendor}`,
        );
      }

      // Secret updates must retain the provider's existing ownership model.
      if (hasClientSecret && existing.clientSecretSource === "EXTERNAL") {
        throw new InputValidationError(
          "this provider uses an external secret; use --client-secret-reference to update it",
        );
      }
      if (hasSecretRef && existing.clientSecretSource === "MANAGED") {
        throw new InputValidationError(
          "this provider uses a managed secret; use --client-secret to update it",
        );
      }

      // Guided updates use this output as the base for settings without flags.
      const existingCustomConfig =
        vendor === "CustomOauth2"
          ? existing.oauth2ProviderConfigOutput?.customOauth2ProviderConfig
          : undefined;
      validateProviderConfigMode(providerConfigMode, vendor, existingCustomConfig);
      validateCompleteConfigKey(providerConfigMode, existing.oauth2ProviderConfigOutput);

      const resolver = new SourceResolver({ stdin: io.stdin });
      const clientSecret = await resolver.resolveSecret("client-secret", flags["client-secret"]);

      const clientSecretConfig = hasSecretRef
        ? parseSecretReference("client-secret-reference", flags["client-secret-reference"]!)
        : undefined;

      const clientSecretSource = existing.clientSecretSource;

      const oauth2ProviderConfigInput = buildProviderConfigInput(providerConfigMode, {
        existingCustomConfig,
        secret: {
          clientSecret,
          clientSecretConfig,
          clientSecretSource,
        },
      });

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.updateOauth2CredentialProvider(
          {
            name: flags.name,
            credentialProviderVendor: vendor,
            oauth2ProviderConfigInput,
          },
          opts,
        ),
      );
    },
  });
