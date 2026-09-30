import z from "zod";
import type { CredentialProviderVendorType } from "@aws-sdk/client-bedrock-agentcore-control";
import type { OAuthCredential } from "../../../../../projectSchemas/credential";
import { createHandler, flag } from "../../../../../router";
import { InputValidationError } from "../../../../../errors";
import { SourceResolver } from "../../../../../io";
import {
  parseProviderConfigFlags,
  validateProviderConfigMode,
} from "../../../../identity/oauth2-credential-provider/config";
import type { AddProjectResourceConfig } from "../../types";
import type { EnvLocalEntry } from "../../../types";
import {
  addCredentialToProject,
  credentialEnvVarName,
  parseExclusiveSecretRef,
  type AddCredentialInput,
} from "../shared";

export type OauthCredentialInput = Omit<OAuthCredential, "authorizerType" | "managed"> & {
  clientSecret?: string;
};

export function toAddOauthCredentialInput(input: OauthCredentialInput): AddCredentialInput {
  const { clientSecret, ...resource } = input;
  const envEntries: EnvLocalEntry[] = input.clientSecretRef
    ? []
    : [
        {
          key: credentialEnvVarName(input.name, "_CLIENT_SECRET"),
          value: clientSecret,
          comment: `OAuth client secret for credential provider '${input.name}' (set before deploy)`,
        },
      ];

  return {
    resourceConfig: {
      authorizerType: "OAuthCredentialProvider",
      ...resource,
    },
    envEntries,
  };
}

export const createAddOauthCredentialHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "oauth",
    description: "add an OAuth2 credential provider to the current project",
    flags: [
      flag("name", "the name of the credential provider", z.string().min(1)),
      flag(
        "vendor",
        "the OAuth2 vendor (e.g. GithubOauth2); custom providers use the guided flags instead",
        z.string().default("CustomOauth2"),
      ),
      flag("client-id", "OAuth2 client ID (guided custom OAuth2)", z.string().optional()),
      flag("discovery-url", "OAuth2 discovery URL (guided custom OAuth2)", z.string().optional()),
      flag(
        "scopes",
        "OAuth2 scopes the provider grants (guided custom OAuth2)",
        z.array(z.string()).optional(),
      ),
      flag(
        "provider-configuration",
        "complete secret-free Oauth2ProviderConfigInput JSON (required for vendored providers)",
        z.string().optional(),
      ),
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
    ],
    handle: async (ctx, flags) => {
      const secretRef = parseExclusiveSecretRef(
        "client-secret-reference",
        flags["client-secret-reference"],
        "client-secret",
        flags["client-secret"],
      );

      const mode = parseProviderConfigFlags({
        clientId: flags["client-id"],
        discoveryUrl: flags["discovery-url"],
        providerConfiguration: flags["provider-configuration"],
      });
      validateProviderConfigMode(mode, flags.vendor as CredentialProviderVendorType);
      if (mode.kind === "complete" && flags.scopes !== undefined) {
        throw new InputValidationError(
          "--provider-configuration and --scopes are mutually exclusive",
        );
      }

      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const clientSecret = await resolver.resolveSecret("client-secret", flags["client-secret"]);

      const credential =
        mode.kind === "complete"
          ? {
              name: flags.name,
              vendor: flags.vendor,
              providerConfig: mode.config,
              clientSecretRef: secretRef,
            }
          : {
              name: flags.name,
              vendor: flags.vendor,
              clientId: flags["client-id"],
              discoveryUrl: flags["discovery-url"],
              scopes: flags.scopes,
              clientSecretRef: secretRef,
            };

      await addCredentialToProject(
        ctx,
        config,
        toAddOauthCredentialInput({ ...credential, clientSecret }),
      );
    },
  });
