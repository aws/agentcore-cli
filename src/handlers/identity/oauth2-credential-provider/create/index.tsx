import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { coreOptsFromCtx, parseTags } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";
import { parseJsonFlag } from "../../../utils";

export const createCreateOauth2CredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an OAuth2 credential provider",
    flags: [
      flag("name", "the name of the OAuth2 credential provider", z.string().optional()),
      flag("vendor", "the OAuth2 vendor (e.g. CustomOauth2, GithubOauth2)", z.string().optional()),
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
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new TypeError("required option '--name <name>' not specified");
      }
      if (!flags.vendor) {
        throw new TypeError("required option '--vendor <vendor>' not specified");
      }

      const hasClientSecret = flags["client-secret"] !== undefined;
      const hasSecretRef = flags["client-secret-reference"] !== undefined;
      const hasProviderConfig = flags["provider-configuration"] !== undefined;
      const hasGuidedFlags =
        flags["client-id"] !== undefined ||
        flags["discovery-url"] !== undefined ||
        flags["authorization-server-metadata"] !== undefined;

      if (hasClientSecret && hasSecretRef) {
        throw new TypeError("--client-secret and --client-secret-reference are mutually exclusive");
      }
      if (!hasClientSecret && !hasSecretRef) {
        throw new TypeError("either --client-secret or --client-secret-reference is required");
      }
      if (hasGuidedFlags && flags.vendor !== "CustomOauth2") {
        throw new TypeError(
          "guided flags (--client-id, --discovery-url, --authorization-server-metadata) are only valid with --vendor CustomOauth2; use --provider-configuration for other vendors",
        );
      }
      if (hasProviderConfig && hasGuidedFlags) {
        throw new TypeError(
          "--provider-configuration and guided flags (--client-id, --discovery-url, --authorization-server-metadata) are mutually exclusive",
        );
      }
      if (flags["discovery-url"] && flags["authorization-server-metadata"]) {
        throw new TypeError(
          "--discovery-url and --authorization-server-metadata are mutually exclusive",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      const clientSecret = await resolver.resolveText("client-secret", flags["client-secret"]);

      const clientSecretConfig = hasSecretRef
        ? parseSecretReference("client-secret-reference", flags["client-secret-reference"]!)
        : undefined;

      const clientSecretSource = hasClientSecret ? "MANAGED" : "EXTERNAL";

      let oauth2ProviderConfigInput: Record<string, unknown>;

      if (hasProviderConfig) {
        const config = parseJsonFlag<Record<string, unknown>>(
          "provider-configuration",
          flags["provider-configuration"],
        )!;
        const configKey = Object.keys(config)[0];
        if (!configKey || typeof config[configKey] !== "object") {
          throw new TypeError(
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

      const tags = parseTags(flags.tags);

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.createOauth2CredentialProvider(
          {
            name: flags.name,
            credentialProviderVendor: flags.vendor as any,
            oauth2ProviderConfigInput: oauth2ProviderConfigInput as any,
            tags,
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
