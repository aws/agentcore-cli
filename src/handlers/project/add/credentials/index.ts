import z from "zod";
import type { CredentialProviderVendorType } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag, ProjectKey, Router, type Context } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { SourceResolver, type AppIO } from "../../../../io";
import { parseSecretReference } from "../../../identity/parser";
import {
  parseProviderConfigFlags,
  validateProviderConfigMode,
} from "../../../identity/oauth2-credential-provider/config";
import type { AddProjectResourceConfig } from "../types";
import type { AddResourceInput, EnvLocalEntry } from "../../types";

export function createAddCredentialsHandler(config: AddProjectResourceConfig): Router {
  const credentials = new Router(
    "credentials",
    "add AgentCore Identity credential providers to the current project",
  );
  credentials.handler(createAddApiKeyCredentialHandler(config));
  credentials.handler(createAddOauthCredentialHandler(config));
  return credentials;
}

/** Derives the .env.local variable name a credential's secret is stored under. */
function credentialEnvVarName(credentialName: string, suffix = ""): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, "_").toUpperCase()}${suffix}`;
}

/**
 * Resolves a secret flag while refusing inline values: an inline secret leaks
 * into shell history and process listings, so only stdin and files are allowed.
 * A single trailing newline is stripped (echo and editors add one).
 */
async function resolveSecretFlag(
  resolver: SourceResolver,
  name: string,
  source: string | undefined,
): Promise<string | undefined> {
  if (source !== undefined && source !== "-" && !source.startsWith("file://")) {
    throw new InputValidationError(
      `--${name} must come from stdin ('-') or a file ('file://<path>'); ` +
        "inline secret values are not accepted",
    );
  }
  const value = await resolver.resolveText(name, source);
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r?\n$/, "");
  if (normalized.includes("\n")) {
    throw new InputValidationError(`--${name} must be a single-line value`);
  }
  return normalized;
}

const createAddApiKeyCredentialHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "api-key",
    description: "add an API key credential provider to the current project",
    flags: [
      flag("name", "the name of the credential provider", z.string().optional()),
      flag(
        "api-key",
        "the API key (file://path or - for stdin; inline values are rejected)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      const secretRef = flags["api-key-secret-reference"]
        ? parseSecretReference("api-key-secret-reference", flags["api-key-secret-reference"])
        : undefined;
      if (secretRef && flags["api-key"] !== undefined) {
        throw new InputValidationError(
          "--api-key and --api-key-secret-reference are mutually exclusive",
        );
      }

      const resolver = new SourceResolver({ stdin: config.io.stdin });
      const apiKey = await resolveSecretFlag(resolver, "api-key", flags["api-key"]);

      const envEntries: EnvLocalEntry[] = secretRef
        ? []
        : [
            {
              key: credentialEnvVarName(flags.name),
              value: apiKey,
              comment: `API key for credential provider '${flags.name}' (set before deploy)`,
            },
          ];

      await addCredentialToProject(ctx, config, {
        resourceConfig: { authorizerType: "ApiKeyCredentialProvider", name: flags.name, secretRef },
        envEntries,
      });
    },
  });

const createAddOauthCredentialHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "oauth",
    description: "add an OAuth2 credential provider to the current project",
    flags: [
      flag("name", "the name of the credential provider", z.string().optional()),
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
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      const secretRef = flags["client-secret-reference"]
        ? parseSecretReference("client-secret-reference", flags["client-secret-reference"])
        : undefined;
      if (secretRef && flags["client-secret"] !== undefined) {
        throw new InputValidationError(
          "--client-secret and --client-secret-reference are mutually exclusive",
        );
      }

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
      const clientSecret = await resolveSecretFlag(
        resolver,
        "client-secret",
        flags["client-secret"],
      );

      const resourceConfig =
        mode.kind === "complete"
          ? {
              authorizerType: "OAuthCredentialProvider" as const,
              name: flags.name,
              vendor: flags.vendor,
              providerConfig: mode.config,
              clientSecretRef: secretRef,
            }
          : {
              authorizerType: "OAuthCredentialProvider" as const,
              name: flags.name,
              vendor: flags.vendor,
              clientId: flags["client-id"],
              discoveryUrl: flags["discovery-url"],
              scopes: flags.scopes,
              clientSecretRef: secretRef,
            };

      const envEntries: EnvLocalEntry[] = secretRef
        ? []
        : [
            {
              key: credentialEnvVarName(flags.name, "_CLIENT_SECRET"),
              value: clientSecret,
              comment: `OAuth client secret for credential provider '${flags.name}' (set before deploy)`,
            },
          ];

      await addCredentialToProject(ctx, config, { resourceConfig, envEntries });
    },
  });

/** Runs the shared add flow: spec update, env entries, progress, and fill-before-deploy notice. */
async function addCredentialToProject(
  ctx: Context,
  config: AddProjectResourceConfig,
  input: Omit<Extract<AddResourceInput, { resourceType: "credential" }>, "resourceType">,
): Promise<void> {
  const project = ctx.require(ProjectKey);
  for await (const event of config.projectManager.addResource(project, {
    resourceType: "credential",
    ...input,
  })) {
    config.io.stderr.write(`${event.message}\n`);
  }

  config.io.stderr.write(`added credential '${input.resourceConfig.name}' to '${project.name}'\n`);
  notifyPlaceholders(config.io, input.envEntries ?? []);
}

/** Tells the user which .env.local keys still need a value before deploy. */
function notifyPlaceholders(io: AppIO, envEntries: EnvLocalEntry[]): void {
  const placeholders = envEntries.filter((entry) => entry.value === undefined);
  for (const entry of placeholders) {
    io.stderr.write(`Set ${entry.key} in agentcore/.env.local before you deploy.\n`);
  }
}
