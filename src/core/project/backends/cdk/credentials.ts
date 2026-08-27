import { join } from "node:path";
import type { Oauth2ProviderConfigInput } from "@aws-sdk/client-bedrock-agentcore-control";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type {
  ApiKeyCredential,
  Credential,
  OAuthCredential,
  SecretReference,
} from "../../../../projectSchemas/credential";
import {
  CLIENT_SECRET_SUFFIX,
  credentialEnvVarName,
  ENV_LOCAL_RELATIVE_PATH,
  EnvLocalFile,
} from "../../envLocal";
import type { CdkCredentialProvider } from "./toolkit";

/** A provisioned provider, in the shape the synthesized CDK app reads back. */
export type DeployedCredential = {
  credentialProviderArn: string;
  clientSecretArn?: string;
};
export type DeployedCredentials = Record<string, DeployedCredential>;

export type ApiKeyProviderInput = {
  name: string;
  /** Inline key material; mutually exclusive with `secretRef`. */
  apiKey?: string;
  /** An existing Secrets Manager secret the customer manages themselves. */
  secretRef?: SecretReference;
};

export type Oauth2ProviderInput = {
  name: string;
  vendor: string;
  config: Oauth2ProviderConfigInput;
};

/**
 * The Identity calls credential provisioning needs. Narrowed to four methods so
 * tests can substitute a recorder without standing up the SDK client, following
 * the seam style of the other backend collaborators in this directory.
 */
export type IdentityProviderClient = {
  getApiKeyProvider(name: string): Promise<DeployedCredential | undefined>;
  createApiKeyProvider(input: ApiKeyProviderInput): Promise<DeployedCredential>;
  getOauth2Provider(name: string): Promise<DeployedCredential | undefined>;
  createOauth2Provider(input: Oauth2ProviderInput): Promise<DeployedCredential>;
};

export type IdentityProviderClientFactory = (
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<IdentityProviderClient>;

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
 * Builds an Identity client against the deployment target's own credentials.
 * The SDK is imported lazily so projects without credentials never pay for
 * loading it, matching how the CloudFormation and STS clients are built.
 */
export const createIdentityProviderClient: IdentityProviderClientFactory = async (
  region,
  credentials,
) => {
  const {
    BedrockAgentCoreControlClient,
    CreateApiKeyCredentialProviderCommand,
    CreateOauth2CredentialProviderCommand,
    GetApiKeyCredentialProviderCommand,
    GetOauth2CredentialProviderCommand,
    ResourceNotFoundException,
  } = await import("@aws-sdk/client-bedrock-agentcore-control");
  const client = new BedrockAgentCoreControlClient({ credentials, region });

  // A missing provider is the normal first-deploy case, not a failure.
  const undefinedWhenAbsent = async <T>(send: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await send();
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  };

  return {
    async getApiKeyProvider(name) {
      const response = await undefinedWhenAbsent(() =>
        client.send(new GetApiKeyCredentialProviderCommand({ name })),
      );
      if (!response) return undefined;
      return {
        credentialProviderArn: requireArn(response.credentialProviderArn, name),
        ...(response.apiKeySecretArn?.secretArn && {
          clientSecretArn: response.apiKeySecretArn.secretArn,
        }),
      };
    },
    async createApiKeyProvider({ name, apiKey, secretRef }) {
      const response = await client.send(
        new CreateApiKeyCredentialProviderCommand({
          name,
          ...(apiKey !== undefined && { apiKey }),
          ...(secretRef && { apiKeySecretConfig: secretRef, apiKeySecretSource: "EXTERNAL" }),
        }),
      );
      return {
        credentialProviderArn: requireArn(response.credentialProviderArn, name),
        ...(response.apiKeySecretArn?.secretArn && {
          clientSecretArn: response.apiKeySecretArn.secretArn,
        }),
      };
    },
    async getOauth2Provider(name) {
      const response = await undefinedWhenAbsent(() =>
        client.send(new GetOauth2CredentialProviderCommand({ name })),
      );
      if (!response) return undefined;
      return {
        credentialProviderArn: requireArn(response.credentialProviderArn, name),
        ...(response.clientSecretArn?.secretArn && {
          clientSecretArn: response.clientSecretArn.secretArn,
        }),
      };
    },
    async createOauth2Provider({ name, vendor, config }) {
      const response = await client.send(
        new CreateOauth2CredentialProviderCommand({
          name,
          // The spec's vendor is free-form so a new service vendor works without
          // a CLI release; the service rejects values it does not know.
          credentialProviderVendor: vendor as never,
          oauth2ProviderConfigInput: config,
        }),
      );
      return {
        credentialProviderArn: requireArn(response.credentialProviderArn, name),
        ...(response.clientSecretArn?.secretArn && {
          clientSecretArn: response.clientSecretArn.secretArn,
        }),
      };
    },
  };
};

/**
 * Creates the credential providers a project declares, before its CloudFormation
 * templates are synthesized: the synthesized app reads the resulting ARNs out of
 * `deployed-state.json` and cannot synthesize a project with credentials until
 * they exist.
 *
 * Providers are created when absent and reused when already present, never
 * updated. Reuse keeps a deploy from minting a new secret version each run and
 * from overwriting a secret rotated outside the CLI; reconciling a provider
 * whose declaration has since changed is deliberately left to a later change.
 */
export function createCredentialProvisioner(
  createClient: IdentityProviderClientFactory = createIdentityProviderClient,
): CredentialProvisioner {
  return async function* provisionCredentials(project, { region, credentials }) {
    const declared = project.spec.credentials;
    if (declared.length === 0) return {};

    // Rejected up front so a project with an unsupported credential fails before
    // any provider is created, rather than part-way through the list.
    const payment = declared.find((c) => c.authorizerType === "PaymentCredentialProvider");
    if (payment) throw paymentUnsupported(payment.name);

    const env = await new EnvLocalFile(project.rootPath).read();
    const client = await createClient(region, credentials);

    const provisioned: DeployedCredentials = {};
    for (const credential of declared) {
      // Provider names are account-global, so a name already taken by another
      // project in this account is adopted rather than recreated.
      yield { message: `Preparing credential provider '${credential.name}'` };
      provisioned[credential.name] = await provisionOne(client, credential, env, project.rootPath);
    }
    return provisioned;
  };
}

async function provisionOne(
  client: IdentityProviderClient,
  credential: Credential,
  env: Record<string, string>,
  rootPath: string,
): Promise<DeployedCredential> {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return provisionApiKey(client, credential, env, rootPath);
    case "OAuthCredentialProvider":
      return provisionOauth2(client, credential, env, rootPath);
    case "PaymentCredentialProvider":
      // Unreachable: rejected before provisioning starts.
      throw paymentUnsupported(credential.name);
  }
}

async function provisionApiKey(
  client: IdentityProviderClient,
  credential: ApiKeyCredential,
  env: Record<string, string>,
  rootPath: string,
): Promise<DeployedCredential> {
  const existing = await client.getApiKeyProvider(credential.name);
  if (existing) return existing;

  if (credential.secretRef) {
    return client.createApiKeyProvider({ name: credential.name, secretRef: credential.secretRef });
  }

  const envKey = credentialEnvVarName(credential.name);
  const apiKey = env[envKey];
  if (!apiKey) throw missingSecret(credential.name, envKey, "secretRef", rootPath);
  return client.createApiKeyProvider({ name: credential.name, apiKey });
}

async function provisionOauth2(
  client: IdentityProviderClient,
  credential: OAuthCredential,
  env: Record<string, string>,
  rootPath: string,
): Promise<DeployedCredential> {
  const existing = await client.getOauth2Provider(credential.name);
  if (existing) return existing;

  let secret: Record<string, unknown>;
  if (credential.clientSecretRef) {
    secret = { clientSecretConfig: credential.clientSecretRef, clientSecretSource: "EXTERNAL" };
  } else {
    const envKey = credentialEnvVarName(credential.name, CLIENT_SECRET_SUFFIX);
    const clientSecret = env[envKey];
    if (!clientSecret) throw missingSecret(credential.name, envKey, "clientSecretRef", rootPath);
    secret = { clientSecret };
  }

  return client.createOauth2Provider({
    name: credential.name,
    vendor: credential.vendor,
    config: credential.providerConfig
      ? vendorConfigWithSecret(credential.name, credential.providerConfig, secret)
      : guidedCustomConfig(credential, secret),
  });
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
      ...(credential.clientId !== undefined && { clientId: credential.clientId }),
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
