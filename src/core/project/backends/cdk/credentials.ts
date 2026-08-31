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
 * tests fake six calls instead of ten.
 */
export type CredentialProviderCalls = Pick<
  CoreIdentityClient,
  | "getApiKeyCredentialProvider"
  | "createApiKeyCredentialProvider"
  | "updateApiKeyCredentialProvider"
  | "getOauth2CredentialProvider"
  | "createOauth2CredentialProvider"
  | "updateOauth2CredentialProvider"
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
 * A provider is created when absent and updated when present, so editing a secret
 * in `.env.local` and redeploying pushes the new value. A provider whose secret the
 * CLI cannot see — nothing in `.env.local` and no external reference — is left
 * exactly as it is rather than failing the deploy.
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

    // Resolve every credential before writing any: look up existing providers and
    // validate the secret each one needs. A missing secret then fails before the
    // first provider is written, not partway through the list.
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
      provisioned[name] = "reuse" in provision ? provision.reuse : await provision.write();
    }
    return provisioned;
  };
}

/**
 * What a credential needs: an existing provider to leave alone, or a write —
 * `create` for a provider that does not exist yet, `update` for one that does —
 * deferred until every credential has been resolved.
 */
type Provision =
  | { reuse: DeployedCredential }
  | { kind: "create" | "update"; write: () => Promise<DeployedCredential> };

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
  // Provider names are account-global, so one already in this account is the one
  // this project's credential resolves to.
  const existing = await undefinedWhenAbsent(() =>
    identity.getApiKeyCredentialProvider(name, options),
  );

  const secret = credential.secretRef
    ? { apiKeySecretConfig: credential.secretRef, apiKeySecretSource: "EXTERNAL" as const }
    : secretFromEnv(env, name, (apiKey) => ({ apiKey }));
  if (!secret) {
    // Nothing to write. An existing provider keeps whatever secret it holds; an
    // absent one cannot be created at all.
    if (existing) return { reuse: apiKeyProvision(name, existing) };
    throw missingSecret(name, credentialEnvVarName(name), "secretRef", rootPath);
  }

  const input = { name, ...secret };
  if (existing) {
    return {
      kind: "update",
      write: async () =>
        apiKeyProvision(name, await identity.updateApiKeyCredentialProvider(input, options)),
    };
  }
  return {
    kind: "create",
    write: async () =>
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

  const secret: Record<string, unknown> | undefined = credential.clientSecretRef
    ? { clientSecretConfig: credential.clientSecretRef, clientSecretSource: "EXTERNAL" }
    : secretFromEnv(env, credential.name, (clientSecret) => ({ clientSecret }), "_CLIENT_SECRET");
  if (!secret) {
    if (existing) return { reuse: oauth2Provision(credential.name, existing) };
    throw missingSecret(
      credential.name,
      credentialEnvVarName(credential.name, "_CLIENT_SECRET"),
      "clientSecretRef",
      rootPath,
    );
  }

  // Projects created by older CLIs kept the client id in .env.local rather than
  // agentcore.json, so fall back to that legacy variable when the spec has none.
  const clientId = credential.clientId ?? env[credentialEnvVarName(credential.name, "_CLIENT_ID")];
  const config = credential.providerConfig
    ? vendorConfigWithSecret(credential.name, credential.providerConfig, secret)
    : guidedCustomConfig(credential, clientId, secret);
  const input = {
    name: credential.name,
    // The spec's vendor is free-form so a new service vendor works without
    // a CLI release; the service rejects values it does not know.
    credentialProviderVendor: credential.vendor as never,
    oauth2ProviderConfigInput: config,
  };
  if (existing) {
    return {
      kind: "update",
      write: async () =>
        oauth2Provision(
          credential.name,
          await identity.updateOauth2CredentialProvider(input, options),
        ),
    };
  }
  return {
    kind: "create",
    write: async () =>
      oauth2Provision(
        credential.name,
        await identity.createOauth2CredentialProvider(input, options),
      ),
  };
}

/**
 * Reads a credential's secret from `.env.local`, shaped into the request field it
 * fills, or undefined when the variable is unset.
 */
function secretFromEnv<T>(
  env: Record<string, string | undefined>,
  name: string,
  field: (secret: string) => T,
  suffix = "",
): T | undefined {
  const secret = env[credentialEnvVarName(name, suffix)];
  return secret ? field(secret) : undefined;
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
