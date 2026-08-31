import { join } from "node:path";
import {
  ResourceNotFoundException,
  type Oauth2ProviderConfigInput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { CoreIdentityClient } from "../../../../handlers/identity/types";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type {
  ApiKeyCredential,
  Credential,
  OAuthCredential,
} from "../../../../projectSchemas/credential";
import { credentialEnvVarName } from "../../../../projectSchemas/credential";
import type { CoreOptions } from "../../../types";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "../../envLocal";
import type { CdkCredentialProvider } from "./toolkit";

/** A provisioned provider, in the shape the synthesized CDK app reads back. */
export type DeployedCredential = {
  credentialProviderArn: string;
  clientSecretArn?: string;
};
export type DeployedCredentials = Record<string, DeployedCredential>;

/**
 * The Identity operations provisioning uses, narrowed from the Core client that
 * backs the `agentcore identity` commands. Narrowed rather than taken whole so
 * tests fake four calls instead of ten.
 */
export type CredentialProviderCalls = Pick<
  CoreIdentityClient,
  | "getApiKeyCredentialProvider"
  | "createApiKeyCredentialProvider"
  | "getOauth2CredentialProvider"
  | "createOauth2CredentialProvider"
>;

export type CredentialProvisionInput = {
  region: string;
  /** Credential provider shared with the rest of the deployment preflight. */
  credentials: CdkCredentialProvider;
};

export type CredentialProvisioner = (
  project: Project,
  input: CredentialProvisionInput,
) => AsyncGenerator<ProjectEvent, DeployedCredentials>;

/**
 * Provisions the credential providers a project declares, before synthesis: the
 * synthesized app reads their ARNs from `deployed-state.json`, so a project with
 * credentials can't synthesize until they exist.
 *
 * Created when absent, reused when present, never updated — so a redeploy neither
 * mints a new secret version nor overwrites one rotated outside the CLI.
 * Reconciling a changed declaration is left to a later change.
 */
export function createCredentialProvisioner(
  identity: CredentialProviderCalls,
): CredentialProvisioner {
  return async function* provisionCredentials(project, { region, credentials }) {
    const declared = project.spec.credentials;
    if (declared.length === 0) return {};

    // Rejected up front so an unsupported credential fails before any AWS call.
    const payment = declared.find((c) => c.authorizerType === "PaymentCredentialProvider");
    if (payment) throw paymentUnsupported(payment.name);

    const env = await new EnvLocalFile(project.rootPath).read();
    // Every Identity call runs against the deployment target's own credentials
    // rather than the default chain, in the region the target deploys to.
    const options: CoreOptions = { region, credentials };

    // Resolve every credential before creating any: look up existing providers
    // (reused as-is) and validate the secret for the rest. A missing secret then
    // fails before the first provider is created, not partway through the list.
    const plans: { name: string; provision: Provision }[] = [];
    for (const credential of declared) {
      plans.push({
        name: credential.name,
        provision: await resolveCredential(identity, credential, options, env, project.rootPath),
      });
    }

    const provisioned: DeployedCredentials = {};
    for (const { name, provision } of plans) {
      yield { message: `Preparing credential provider '${name}'` };
      provisioned[name] = "reuse" in provision ? provision.reuse : await provision.create();
    }
    return provisioned;
  };
}

/** An existing provider to reuse, or a creation deferred until every secret is validated. */
type Provision = { reuse: DeployedCredential } | { create: () => Promise<DeployedCredential> };

function resolveCredential(
  identity: CredentialProviderCalls,
  credential: Credential,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return resolveApiKey(identity, credential, options, env, rootPath);
    case "OAuthCredentialProvider":
      return resolveOauth2(identity, credential, options, env, rootPath);
    case "PaymentCredentialProvider":
      // Unreachable: rejected before provisioning starts.
      throw paymentUnsupported(credential.name);
  }
}

async function resolveApiKey(
  identity: CredentialProviderCalls,
  credential: ApiKeyCredential,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  const { name } = credential;
  // Provider names are account-global, so one already in this account is reused.
  const existing = await undefinedWhenAbsent(() =>
    identity.getApiKeyCredentialProvider(name, options),
  );
  if (existing) return { reuse: apiKeyProvision(name, existing) };

  const input = credential.secretRef
    ? { name, apiKeySecretConfig: credential.secretRef, apiKeySecretSource: "EXTERNAL" as const }
    : { name, apiKey: requireEnvSecret(name, env, rootPath, "secretRef") };
  return {
    create: async () =>
      apiKeyProvision(name, await identity.createApiKeyCredentialProvider(input, options)),
  };
}

async function resolveOauth2(
  identity: CredentialProviderCalls,
  credential: OAuthCredential,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  const existing = await undefinedWhenAbsent(() =>
    identity.getOauth2CredentialProvider(credential.name, options),
  );
  if (existing) return { reuse: oauth2Provision(credential.name, existing) };

  const secret: Record<string, unknown> = credential.clientSecretRef
    ? { clientSecretConfig: credential.clientSecretRef, clientSecretSource: "EXTERNAL" }
    : {
        clientSecret: requireEnvSecret(
          credential.name,
          env,
          rootPath,
          "clientSecretRef",
          "_CLIENT_SECRET",
        ),
      };
  // Projects created by older CLIs kept the client id in .env.local rather than
  // agentcore.json, so fall back to that legacy variable when the spec has none.
  const clientId = credential.clientId ?? env[credentialEnvVarName(credential.name, "_CLIENT_ID")];
  const config = credential.providerConfig
    ? vendorConfigWithSecret(credential.name, credential.providerConfig, secret)
    : guidedCustomConfig(credential, clientId, secret);
  return {
    create: async () =>
      oauth2Provision(
        credential.name,
        await identity.createOauth2CredentialProvider(
          {
            name: credential.name,
            // The spec's vendor is free-form so a new service vendor works without
            // a CLI release; the service rejects values it does not know.
            credentialProviderVendor: credential.vendor as never,
            oauth2ProviderConfigInput: config,
          },
          options,
        ),
      ),
  };
}

/**
 * A provider lookup that treats "not found" as absent. Identity throws for a
 * provider that does not exist yet, which is the normal first-deploy case.
 */
async function undefinedWhenAbsent<T>(send: () => Promise<T>): Promise<T | undefined> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

// The two provider families report their secret under different response fields,
// so each maps its own; both record the same shape in deployed-state.json.
function apiKeyProvision(
  name: string,
  response: { credentialProviderArn?: string; apiKeySecretArn?: { secretArn?: string } },
): DeployedCredential {
  return deployedCredential(
    name,
    response.credentialProviderArn,
    response.apiKeySecretArn?.secretArn,
  );
}

function oauth2Provision(
  name: string,
  response: { credentialProviderArn?: string; clientSecretArn?: { secretArn?: string } },
): DeployedCredential {
  return deployedCredential(
    name,
    response.credentialProviderArn,
    response.clientSecretArn?.secretArn,
  );
}

function deployedCredential(
  name: string,
  credentialProviderArn: string | undefined,
  secretArn: string | undefined,
): DeployedCredential {
  return {
    credentialProviderArn: requireArn(credentialProviderArn, name),
    ...(secretArn && { clientSecretArn: secretArn }),
  };
}

/** Reads a credential's secret from `.env.local`, throwing an actionable error when absent. */
function requireEnvSecret(
  name: string,
  env: Record<string, string | undefined>,
  rootPath: string,
  refField: "secretRef" | "clientSecretRef",
  suffix = "",
): string {
  const envKey = credentialEnvVarName(name, suffix);
  const secret = env[envKey];
  if (!secret) throw missingSecret(name, envKey, refField, rootPath);
  return secret;
}

/**
 * Injects the secret into a complete, spec-supplied vendor config. The spec
 * keeps provider configs secret-free, so the one vendor key it carries is the
 * only place the secret can go.
 */
function vendorConfigWithSecret(
  name: string,
  providerConfig: Record<string, unknown>,
  secret: Record<string, unknown>,
): Oauth2ProviderConfigInput {
  const entries = Object.entries(providerConfig);
  const [configKey, vendorConfig] = entries[0] ?? [];
  if (
    entries.length !== 1 ||
    !configKey ||
    typeof vendorConfig !== "object" ||
    vendorConfig === null ||
    Array.isArray(vendorConfig)
  ) {
    throw new ProjectStateError(
      `Credential '${name}' has a providerConfig with ${entries.length} entries; it must hold ` +
        `exactly one vendor config object (for example { "customOauth2ProviderConfig": { ... } }).`,
    );
  }
  return { [configKey]: { ...vendorConfig, ...secret } } as unknown as Oauth2ProviderConfigInput;
}

function guidedCustomConfig(
  credential: OAuthCredential,
  clientId: string | undefined,
  secret: Record<string, unknown>,
): Oauth2ProviderConfigInput {
  // The spec's schema requires discoveryUrl for a guided credential; this guards
  // a spec written before that rule rather than a reachable state.
  if (!credential.discoveryUrl) {
    throw new ProjectStateError(
      `Credential '${credential.name}' needs either a discoveryUrl or a providerConfig ` +
        `to create its OAuth2 provider.`,
    );
  }
  // `scopes` is deliberately not forwarded: provider creation has no scopes
  // field, and the spec's scopes are consumed where the credential is used.
  return {
    customOauth2ProviderConfig: {
      oauthDiscovery: { discoveryUrl: credential.discoveryUrl },
      ...(clientId !== undefined && { clientId }),
      ...secret,
    },
  };
}

function missingSecret(
  name: string,
  envKey: string,
  refField: "secretRef" | "clientSecretRef",
  rootPath: string,
): ProjectStateError {
  return new ProjectStateError(
    `Credential '${name}' has no secret to create its provider with. Set ${envKey} in ` +
      `${join(rootPath, ENV_LOCAL_RELATIVE_PATH)}, or give the credential a '${refField}' in ` +
      `agentcore.json pointing at a secret you keep in AWS Secrets Manager.`,
  );
}

function paymentUnsupported(name: string): ProjectStateError {
  return new ProjectStateError(
    `Credential '${name}' is a PaymentCredentialProvider, which 'agentcore project deploy' ` +
      `cannot create: a payment provider needs vendor configuration (API key, wallet and ` +
      `authorization secrets) that agentcore.json has no fields for. Remove it from the project ` +
      `spec to deploy the rest of the project.`,
  );
}

function requireArn(arn: string | undefined, name: string): string {
  if (!arn) {
    throw new MalformedServiceResponseError(
      `Identity returned no credentialProviderArn for credential provider '${name}'`,
    );
  }
  return arn;
}
