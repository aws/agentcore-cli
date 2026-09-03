import z from "zod";
import type { CredentialProviderVendorType } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { coreOptsFromCtx, parseTags } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";
import {
  buildProviderConfigInput,
  parseProviderConfigFlags,
  validateProviderConfigMode,
} from "../config";

export const createCreateOauth2CredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an OAuth2 credential provider",
    flags: [
      flag("name", "the name of the OAuth2 credential provider", z.string().optional()),
      flag("vendor", "the OAuth2 vendor (e.g. CustomOauth2, GithubOauth2)", z.string().optional()),
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
      flag("client-id", "OAuth2 client ID (guided custom OAuth2)", z.string().optional()),
      flag("discovery-url", "OAuth2 discovery URL (guided custom OAuth2)", z.string().optional()),
      flag(
        "authorization-server-metadata",
        "authorization server metadata JSON (guided custom OAuth2)",
        z.string().optional(),
      ),
      flag(
        "provider-configuration",
        "complete OAuth2 provider configuration JSON (alternative to guided flags)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags.vendor) {
        throw new InputValidationError("required option '--vendor <vendor>' not specified");
      }

      const vendor = flags.vendor as CredentialProviderVendorType;
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
      validateProviderConfigMode(providerConfigMode, vendor);

      const resolver = new SourceResolver({ stdin: io.stdin });
      const clientSecret = await resolver.resolveSecret("client-secret", flags["client-secret"]);

      const clientSecretConfig = hasSecretRef
        ? parseSecretReference("client-secret-reference", flags["client-secret-reference"]!)
        : undefined;

      const clientSecretSource = hasClientSecret ? "MANAGED" : "EXTERNAL";

      const oauth2ProviderConfigInput = buildProviderConfigInput(providerConfigMode, {
        secret: {
          clientSecret,
          clientSecretConfig,
          clientSecretSource,
        },
      });

      const tags = parseTags(flags.tags);

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.createOauth2CredentialProvider(
          {
            name: flags.name,
            credentialProviderVendor: vendor,
            oauth2ProviderConfigInput,
            tags,
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
