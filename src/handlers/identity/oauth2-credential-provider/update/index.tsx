import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { coreOptsFromCtx } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";
import { parseJsonFlag } from "../../../utils";

export const createUpdateOauth2CredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an OAuth2 credential provider",
    flags: [
      flag("name", "the name of the OAuth2 credential provider", z.string().optional()),
      flag("vendor", "the OAuth2 vendor", z.string().optional()),
      flag(
        "client-secret",
        "the client secret (inline, file://path, or -)",
        z.string().optional(),
        {
          sensitive: true,
        },
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
      const hasProviderConfig = flags["provider-configuration"] !== undefined;
      const hasDiscoveryUrl = flags["discovery-url"] !== undefined;
      const hasAuthServerMetadata = flags["authorization-server-metadata"] !== undefined;
      const hasGuidedFlags =
        flags["client-id"] !== undefined || hasDiscoveryUrl || hasAuthServerMetadata;

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
      if (hasProviderConfig && hasGuidedFlags) {
        throw new InputValidationError(
          "--provider-configuration and guided flags (--client-id, --discovery-url, --authorization-server-metadata) are mutually exclusive",
        );
      }
      if (hasDiscoveryUrl && hasAuthServerMetadata) {
        throw new InputValidationError(
          "--discovery-url and --authorization-server-metadata are mutually exclusive",
        );
      }

      const opts = coreOptsFromCtx(ctx);
      const existing = await core.identity.getOauth2CredentialProvider(flags.name, opts);

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

      const vendor = flags.vendor ?? existing.credentialProviderVendor;
      if (!vendor) {
        throw new InputValidationError("required option '--vendor <vendor>' not specified");
      }
      const isCustomVendor = vendor === "CustomOauth2";
      if (hasGuidedFlags && !isCustomVendor) {
        throw new InputValidationError(
          "guided flags (--client-id, --discovery-url, --authorization-server-metadata) are only valid with --vendor CustomOauth2; use --provider-configuration for other vendors",
        );
      }
      // non-custom vendors must supply a complete provider-configuration
      if (!isCustomVendor && !hasProviderConfig) {
        throw new InputValidationError(
          `--provider-configuration is required for --vendor ${vendor}; guided flags only support CustomOauth2`,
        );
      }
      // the guided CustomOAuth2 path requires one discovery form
      if (isCustomVendor && !hasProviderConfig && !hasDiscoveryUrl && !hasAuthServerMetadata) {
        throw new InputValidationError(
          "guided --vendor CustomOauth2 requires one of --discovery-url or --authorization-server-metadata",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      const clientSecret = await resolver.resolveText("client-secret", flags["client-secret"]);

      const clientSecretConfig = hasSecretRef
        ? parseSecretReference("client-secret-reference", flags["client-secret-reference"]!)
        : undefined;

      const clientSecretSource = existing.clientSecretSource;

      let oauth2ProviderConfigInput: Record<string, unknown>;

      if (hasProviderConfig) {
        const config = parseJsonFlag<Record<string, unknown>>(
          "provider-configuration",
          flags["provider-configuration"],
        )!;
        const configKey = Object.keys(config)[0];
        if (!configKey || typeof config[configKey] !== "object") {
          throw new InputValidationError(
            "--provider-configuration must contain a single vendor config object",
          );
        }
        const vendorConfig = config[configKey] as Record<string, unknown>;
        vendorConfig.clientSecret = clientSecret;
        vendorConfig.clientSecretConfig = clientSecretConfig;
        vendorConfig.clientSecretSource = clientSecretSource;
        oauth2ProviderConfigInput = config;
      } else {
        const authServerMetadata = parseJsonFlag<Record<string, unknown>>(
          "authorization-server-metadata",
          flags["authorization-server-metadata"],
        );

        const oauthDiscovery: Record<string, unknown> = {};
        if (flags["discovery-url"]) {
          oauthDiscovery.discoveryUrl = flags["discovery-url"];
        }
        if (authServerMetadata) {
          oauthDiscovery.authorizationServerMetadata = authServerMetadata;
        }

        oauth2ProviderConfigInput = {
          customOauth2ProviderConfig: {
            clientId: flags["client-id"],
            clientSecret,
            clientSecretConfig,
            clientSecretSource,
            ...(Object.keys(oauthDiscovery).length > 0 && { oauthDiscovery }),
          },
        };
      }

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.updateOauth2CredentialProvider(
          {
            name: flags.name,
            credentialProviderVendor: vendor as any,
            oauth2ProviderConfigInput: oauth2ProviderConfigInput as any,
          },
          opts,
        ),
      );
    },
  });
