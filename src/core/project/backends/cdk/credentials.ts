import { join } from "node:path";
import {
  ResourceNotFoundException,
  type Oauth2ProviderConfigInput,
  type PaymentProviderConfigurationInput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { CoreIdentityClient } from "../../../../handlers/identity/types";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type {
  ApiKeyCredential,
  Credential,
  OAuthCredential,
  PaymentCredential,
} from "../../../../projectSchemas/credential";
import {
  CREDENTIAL_ENV_PREFIX,
  CredentialNameSchema,
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
} from "../../../../projectSchemas/credential";
import type { CoreOptions } from "../../../types";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "../../envLocal";
import type { CdkCredentialProvider } from "./toolkit";

/** A provisioned provider, in the shape the synthesized CDK app reads back. */
export type DeployedCredential = {
  credentialProviderArn: string;
  clientSecretArn?: string;
  /**
   * Which kind of provider the ARN belongs to. Recorded so a teardown knows which
   * providers it owns without the spec that declared them — `project remove all`
   * empties the spec before the deploy that tears the target down.
   */
  authorizerType?: Credential["authorizerType"];
};
export type DeployedCredentials = Record<string, DeployedCredential>;

/**
 * The Identity name a credential's provider is created under. Scoped to the project
 * and target so two targets in one account and region never share a provider.
 */
function providerName(projectName: string, targetName: string, credentialName: string): string {
  return `${projectName}_${targetName}_${credentialName}`;
}

const PROVIDER_NAME_MAX_LENGTH = CredentialNameSchema.maxLength!;

/**
 * The type segment Identity puts in each kind's ARN, used to classify entries
 * recorded before `authorizerType` was persisted.
 */
const ARN_SEGMENT_KINDS: Record<string, Credential["authorizerType"]> = {
  "/apikeycredentialprovider/": "ApiKeyCredentialProvider",
  "/oauth2credentialprovider/": "OAuthCredentialProvider",
  "/paymentcredentialprovider/": "PaymentCredentialProvider",
};

const DELETE_COMMANDS: Record<Credential["authorizerType"], string> = {
  ApiKeyCredentialProvider: "delete-api-key-credential-provider",
  OAuthCredentialProvider: "delete-oauth2-credential-provider",
  PaymentCredentialProvider: "delete-payment-credential-provider",
};

function recordedKind(state: DeployedCredential): Credential["authorizerType"] | undefined {
  if (state.authorizerType) return state.authorizerType;
  return Object.entries(ARN_SEGMENT_KINDS).find(([segment]) =>
    state.credentialProviderArn.includes(segment),
  )?.[1];
}

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
  | "getPaymentCredentialProvider"
  | "createPaymentCredentialProvider"
  | "updatePaymentCredentialProvider"
  // Deletes undo what a failed deploy created and remove what a torn-down target
  // owns. A provider that already existed is never deleted by a deploy.
  | "deleteApiKeyCredentialProvider"
  | "deleteOauth2CredentialProvider"
  | "deletePaymentCredentialProvider"
>;

type ProviderDeletes = Pick<
  CredentialProviderCalls,
  | "deleteApiKeyCredentialProvider"
  | "deleteOauth2CredentialProvider"
  | "deletePaymentCredentialProvider"
>;

export type CredentialProvisionInput = {
  region: string;
  /** Credential provider shared with the rest of the deployment preflight. */
  credentials: CdkCredentialProvider;
  targetName: string;
};

export type CredentialProvisioner = (
  project: Project,
  input: CredentialProvisionInput,
) => AsyncGenerator<ProjectEvent, DeployedCredentials>;

export type CredentialRemovalInput = CredentialProvisionInput & {
  /**
   * The providers deployed-state.json recorded for this target, read before the
   * deploy overwrote them.
   */
  recorded: DeployedCredentials;
};

export type CredentialRemover = (
  project: Project,
  input: CredentialRemovalInput,
) => AsyncGenerator<ProjectEvent, void>;

/**
 * Deletes the credential providers a target provisioned, for a teardown that has
 * already removed its stack.
 *
 * Taken from the recorded state and not only from the spec: a teardown is reached by
 * declaring nothing to deploy, and `project remove all` gets there by emptying the
 * spec — including the credentials that name the providers to delete. The spec is
 * still consulted, so a project whose state predates the CLI recording credentials
 * still has its providers removed.
 *
 * Every kind is deleted. A provider's name is scoped to this project and target, so
 * nothing outside this target can be using it.
 *
 * A provider that is already gone is not an error, and a provider that cannot be
 * deleted is reported rather than failing a teardown whose stack is already gone.
 */
export function createCredentialRemover(identity: ProviderDeletes): CredentialRemover {
  return async function* removeCredentials(project, { region, credentials, targetName, recorded }) {
    const owned = new Map<string, Credential["authorizerType"]>();
    for (const [name, state] of Object.entries(recorded)) {
      const kind = recordedKind(state);
      if (kind) owned.set(name, kind);
    }
    for (const { name, authorizerType } of project.spec.credentials) {
      owned.set(name, authorizerType);
    }

    const options: CoreOptions = { region, credentials };
    for (const [name, kind] of owned) {
      const provider = providerName(project.name, targetName, name);
      yield { type: "step", message: `Removing credential provider '${provider}'` };
      try {
        await deleteProvider(identity, kind, provider, options);
      } catch (error) {
        if (error instanceof ResourceNotFoundException) continue;
        yield {
          type: "step",
          message:
            `Could not remove credential provider '${provider}': ${(error as Error).message}. ` +
            `Delete it with 'aws bedrock-agentcore-control ${DELETE_COMMANDS[kind]}'.`,
        };
      }
    }
  };
}

/** A declared credential paired with the Identity provider name it resolves to. */
type NamedCredential = { credential: Credential; provider: string };

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
  processEnv: Record<string, string | undefined> = process.env,
): CredentialProvisioner {
  return async function* provisionCredentials(project, { region, credentials, targetName }) {
    const declared = project.spec.credentials;
    if (declared.length === 0) return {};

    // Credential variables set in the process environment win over the file, so a
    // deploy can be handed its secrets without writing them to disk first.
    const env = {
      ...(await new EnvLocalFile(project.rootPath).read()),
      ...credentialEnvironment(processEnv),
    };
    // Every Identity call runs against the deployment target's own credentials
    // rather than the default chain, in the region the target deploys to.
    const options: CoreOptions = { region, credentials };

    // Every name is composed and checked before the first lookup, so one that is
    // too long fails the deploy before it touches Identity.
    const named: NamedCredential[] = declared.map((credential) => {
      const provider = providerName(project.name, targetName, credential.name);
      if (provider.length > PROVIDER_NAME_MAX_LENGTH) {
        throw new ProjectStateError(
          `Credential '${credential.name}' would create a credential provider named ` +
            `'${provider}' for target '${targetName}', which is ${provider.length} characters. ` +
            `Provider names are at most ${PROVIDER_NAME_MAX_LENGTH} characters. Shorten the ` +
            `credential name or the target name.`,
        );
      }
      return { credential, provider };
    });

    // Resolve every credential before writing any: look up existing providers and
    // validate the secret each one needs. A missing secret then fails before the
    // first provider is written, not partway through the list.
    const plans: (NamedCredential & { provision: Provision })[] = [];
    for (const { credential, provider } of named) {
      plans.push({
        credential,
        provider,
        provision: await resolveCredential(
          identity,
          credential,
          provider,
          options,
          env,
          project.rootPath,
        ),
      });
    }

    const provisioned: DeployedCredentials = {};
    // Providers this deploy brought into existence, so a later failure can undo them
    // rather than leaving one behind that nothing records.
    const created: NamedCredential[] = [];
    try {
      for (const { credential, provider, provision } of plans) {
        yield { type: "step", message: `Preparing credential provider '${provider}'` };
        if ("reuse" in provision) {
          provisioned[credential.name] = provision.reuse;
          continue;
        }
        // Recorded before the write, not after: a create whose response then fails
        // validation has already created the provider, and rollback has to know about
        // it. A create that never reached the service leaves nothing to delete, which
        // rollback treats as already gone.
        if (provision.kind === "create") created.push({ credential, provider });
        provisioned[credential.name] = await provision.write();
      }
    } catch (error) {
      yield* rollback(identity, created, options);
      throw error;
    }
    return provisioned;
  };
}

/**
 * Deletes the providers a failed deploy created, newest first. A provider that
 * already existed is left alone — this deploy only updated its secret, and undoing
 * that would need the value it held before.
 *
 * A deletion that fails is reported rather than thrown: the error that started the
 * rollback is the one the user needs to see. A provider that is not there was never
 * created — the create is recorded before the call it describes, so that the reverse
 * mistake, forgetting one that was created, cannot happen.
 */
async function* rollback(
  identity: ProviderDeletes,
  created: NamedCredential[],
  options: CoreOptions,
): AsyncGenerator<ProjectEvent, void> {
  for (const { credential, provider } of [...created].reverse()) {
    yield {
      type: "step",
      message: `Removing credential provider '${provider}' this deploy created`,
    };
    try {
      await deleteProvider(identity, credential.authorizerType, provider, options);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) continue;
      yield {
        type: "step",
        message:
          `Could not remove credential provider '${provider}': ` +
          `${(error as Error).message}. It exists in AWS but is not recorded, so the next ` +
          `deploy of this target will adopt it.`,
      };
    }
  }
}

function deleteProvider(
  identity: ProviderDeletes,
  kind: Credential["authorizerType"],
  provider: string,
  options: CoreOptions,
): Promise<unknown> {
  switch (kind) {
    case "ApiKeyCredentialProvider":
      return identity.deleteApiKeyCredentialProvider(provider, options);
    case "OAuthCredentialProvider":
      return identity.deleteOauth2CredentialProvider(provider, options);
    case "PaymentCredentialProvider":
      return identity.deletePaymentCredentialProvider(provider, options);
  }
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
  provider: string,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return resolveApiKey(identity, credential, provider, options, env, rootPath);
    case "OAuthCredentialProvider":
      return resolveOauth2(identity, credential, provider, options, env, rootPath);
    case "PaymentCredentialProvider":
      return resolvePayment(identity, credential, provider, options, env, rootPath);
  }
}

async function resolveApiKey(
  identity: CredentialProviderCalls,
  credential: ApiKeyCredential,
  provider: string,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  const { name } = credential;
  // Provider names are account-global, so one already under this target's scoped
  // name is the one this credential resolves to.
  const existing = await undefinedWhenAbsent(() =>
    identity.getApiKeyCredentialProvider(provider, options),
  );

  const secret = credential.secretRef
    ? { apiKeySecretConfig: credential.secretRef, apiKeySecretSource: "EXTERNAL" as const }
    : secretFromEnv(env, name, (apiKey) => ({ apiKey }));
  if (!secret) {
    // Nothing to write. An existing provider keeps whatever secret it holds; an
    // absent one cannot be created at all.
    if (existing) return { reuse: apiKeyProvision(provider, existing) };
    throw missingSecret(name, credentialEnvVarName(name), "secretRef", rootPath);
  }

  const input = { name: provider, ...secret };
  if (existing) {
    return {
      kind: "update",
      write: async () =>
        apiKeyProvision(provider, await identity.updateApiKeyCredentialProvider(input, options)),
    };
  }
  return {
    kind: "create",
    write: async () =>
      apiKeyProvision(provider, await identity.createApiKeyCredentialProvider(input, options)),
  };
}

async function resolveOauth2(
  identity: CredentialProviderCalls,
  credential: OAuthCredential,
  provider: string,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  const existing = await undefinedWhenAbsent(() =>
    identity.getOauth2CredentialProvider(provider, options),
  );
  if (existing) requireVendorMatch(credential.name, provider, credential.vendor, existing);

  const secret: Record<string, unknown> | undefined = credential.clientSecretRef
    ? { clientSecretConfig: credential.clientSecretRef, clientSecretSource: "EXTERNAL" }
    : secretFromEnv(env, credential.name, (clientSecret) => ({ clientSecret }), "_CLIENT_SECRET");
  if (!secret) {
    if (existing) return { reuse: oauth2Provision(provider, existing) };
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
    name: provider,
    // The spec's vendor is free-form so a new service vendor works without
    // a CLI release; the service rejects values it does not know.
    credentialProviderVendor: credential.vendor as never,
    oauth2ProviderConfigInput: config,
  };
  if (existing) {
    return {
      kind: "update",
      write: async () =>
        oauth2Provision(provider, await identity.updateOauth2CredentialProvider(input, options)),
    };
  }
  return {
    kind: "create",
    write: async () =>
      oauth2Provision(provider, await identity.createOauth2CredentialProvider(input, options)),
  };
}

/**
 * The credential variables an environment carries. Filtered to the credential prefix
 * so a deploy reads the secrets it was handed and nothing else from the environment.
 */
function credentialEnvironment(
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(processEnv).filter(([key]) => key.startsWith(CREDENTIAL_ENV_PREFIX)),
  );
}

/**
 * A payment provider's fields all come from the environment — the vendor's own
 * identifiers as well as its secrets — so the credential is written only when every
 * one of them is present, and an existing provider is otherwise left alone.
 */
async function resolvePayment(
  identity: CredentialProviderCalls,
  credential: PaymentCredential,
  provider: string,
  options: CoreOptions,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Provision> {
  const { name } = credential;
  const existing = await undefinedWhenAbsent(() =>
    identity.getPaymentCredentialProvider(provider, options),
  );
  if (existing) requireVendorMatch(name, provider, credential.provider, existing);

  const fields = paymentFields(credential, env);
  if ("missing" in fields) {
    if (existing) return { reuse: paymentProvision(provider, existing) };
    throw missingPaymentSecrets(name, fields.missing, rootPath);
  }

  const input = {
    name: provider,
    credentialProviderVendor: credential.provider as never,
    providerConfigurationInput: fields.configuration,
  };
  if (existing) {
    return {
      kind: "update",
      write: async () =>
        paymentProvision(provider, await identity.updatePaymentCredentialProvider(input, options)),
    };
  }
  return {
    kind: "create",
    write: async () =>
      paymentProvision(provider, await identity.createPaymentCredentialProvider(input, options)),
  };
}

/**
 * Collects a payment vendor's configuration from the environment, or reports every
 * variable that is unset so the user can fill them in one pass.
 */
function paymentFields(
  credential: PaymentCredential,
  env: Record<string, string | undefined>,
): { configuration: PaymentProviderConfigurationInput } | { missing: string[] } {
  const read = (suffix: string) => env[credentialEnvVarName(credential.name, suffix)];
  const missing = credentialEnvironmentVariableNames(credential).filter((key) => !env[key]);
  if (missing.length > 0) return { missing };

  if (credential.provider === "CoinbaseCDP") {
    return {
      configuration: {
        coinbaseCdpConfiguration: {
          apiKeyId: read("_API_KEY_ID")!,
          apiKeySecret: read("_API_KEY_SECRET")!,
          walletSecret: read("_WALLET_SECRET")!,
        },
      },
    };
  }
  return {
    configuration: {
      stripePrivyConfiguration: {
        appId: read("_APP_ID")!,
        appSecret: read("_APP_SECRET")!,
        authorizationPrivateKey: read("_AUTHORIZATION_PRIVATE_KEY")!,
        authorizationId: read("_AUTHORIZATION_ID")!,
      },
    },
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
 * Refuses an existing provider whose vendor is not the one the credential declares.
 *
 * Provider names are account-global within a provider kind, so the name a credential
 * resolves to can already be taken by a provider of a different vendor. Reusing it
 * would record an unrelated provider's ARN as this credential's — a Stripe provider
 * standing in for a Coinbase connector — and updating it would push one vendor's
 * configuration at another vendor's provider. Neither is recoverable by the user
 * without knowing it happened, so both fail here instead.
 */
function requireVendorMatch(
  name: string,
  provider: string,
  declared: string,
  existing: { credentialProviderVendor?: string },
): void {
  const actual = existing.credentialProviderVendor;
  if (!actual || actual === declared) return;
  throw new ProjectStateError(
    `Credential '${name}' declares vendor '${declared}', but a credential provider named ` +
      `'${provider}' already exists in this account with vendor '${actual}'. Provider names ` +
      `are shared across an account: rename the credential, or delete the existing provider ` +
      `if nothing else uses it.`,
  );
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
  provider: string,
  response: { credentialProviderArn?: string; apiKeySecretArn?: { secretArn?: string } },
): DeployedCredential {
  return deployedCredential(
    provider,
    "ApiKeyCredentialProvider",
    response.credentialProviderArn,
    response.apiKeySecretArn?.secretArn,
  );
}

function oauth2Provision(
  provider: string,
  response: { credentialProviderArn?: string; clientSecretArn?: { secretArn?: string } },
): DeployedCredential {
  return deployedCredential(
    provider,
    "OAuthCredentialProvider",
    response.credentialProviderArn,
    response.clientSecretArn?.secretArn,
  );
}

// A payment provider holds several secrets rather than one, each reported under its
// vendor's own field, so only the provider ARN is recorded.
function paymentProvision(
  provider: string,
  response: { credentialProviderArn?: string },
): DeployedCredential {
  return deployedCredential(
    provider,
    "PaymentCredentialProvider",
    response.credentialProviderArn,
    undefined,
  );
}

function deployedCredential(
  provider: string,
  authorizerType: Credential["authorizerType"],
  credentialProviderArn: string | undefined,
  secretArn: string | undefined,
): DeployedCredential {
  return {
    credentialProviderArn: requireArn(credentialProviderArn, provider),
    ...(secretArn && { clientSecretArn: secretArn }),
    authorizerType,
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
      `${join(rootPath, ENV_LOCAL_RELATIVE_PATH)} or in the environment you deploy from, or ` +
      `give the credential a '${refField}' in agentcore.json pointing at a secret you keep in ` +
      `AWS Secrets Manager.`,
  );
}

function missingPaymentSecrets(
  name: string,
  missing: string[],
  rootPath: string,
): ProjectStateError {
  return new ProjectStateError(
    `Credential '${name}' is missing the values its payment provider needs: ` +
      `${missing.join(", ")}. Set them in ${join(rootPath, ENV_LOCAL_RELATIVE_PATH)} or in the ` +
      `environment you deploy from.`,
  );
}

function requireArn(arn: string | undefined, provider: string): string {
  if (!arn) {
    throw new MalformedServiceResponseError(
      `Identity returned no credentialProviderArn for credential provider '${provider}'`,
    );
  }
  return arn;
}
