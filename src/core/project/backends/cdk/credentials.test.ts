import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResourceNotFoundException,
  type GetApiKeyCredentialProviderResponse,
  type GetOauth2CredentialProviderResponse,
  type GetPaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { CoreOptions } from "../../../types";
import { EnvLocalFile } from "../../envLocal";
import {
  createCredentialProvisioner,
  createPaymentCredentialRemover,
  type CredentialProviderCalls,
  type CredentialProvisioner,
  type DeployedCredential,
  type DeployedCredentials,
} from "./credentials";
import type { CdkCredentialProvider } from "./toolkit";

const REGION = "us-east-1";
const CREDENTIALS: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});
const OPTIONS: CoreOptions = { region: REGION, credentials: CREDENTIALS };

const API_KEY = { authorizerType: "ApiKeyCredentialProvider", name: "openai-key" } as const;
const DISCOVERY = "https://example.com/.well-known/openid-configuration";
const OAUTH = {
  authorizerType: "OAuthCredentialProvider",
  name: "my-oauth",
  clientId: "client-1",
  discoveryUrl: DISCOVERY,
  scopes: ["read"],
} as const;
const COINBASE = {
  authorizerType: "PaymentCredentialProvider",
  name: "wallet",
  provider: "CoinbaseCDP",
} as const;

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(credentials: unknown[], envLocal?: string): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-credentials-"));
  tempDirectories.push(rootPath);
  const file = new EnvLocalFile(rootPath);
  await mkdir(dirname(file.path), { recursive: true });
  if (envLocal !== undefined) await writeFile(file.path, envLocal);
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "example", version: 1, credentials }),
  };
}

type ProviderKind = "apikey" | "oauth" | "payment";

/**
 * A provider as it exists in the fake account. Tests assert against these rather than
 * against a call log, so a change in how provisioning gets to this state does not
 * break them.
 */
type StoredProvider = {
  credentialProviderArn?: string;
  clientSecretArn?: string;
  /** The request body this provider was last written with; absent if never written. */
  config?: unknown;
  /** How this run last touched it; absent when it was left exactly as found. */
  operation?: "created" | "updated";
};

/** Overrides for the paths that only a failing or incomplete Identity produces. */
type Behavior = {
  /** Thrown by every lookup, in place of reporting what the account holds. */
  getFails?: Error;
  /** The ARNs every write returns, in place of fully populated ones. */
  writeReturns?: DeployedCredential;
  /** Thrown by every deletion. */
  deleteFails?: Error;
  /** Thrown when the named provider would be created. */
  createFailsFor?: string;
};

/**
 * An in-memory Identity account: providers can be looked up, created, updated and
 * deleted, and the resulting contents are what tests assert on.
 *
 * `deleted` is tracked separately because a provider that was created and then rolled
 * back is indistinguishable from one that was never created by looking at the
 * contents alone, and that distinction is the whole point of the rollback path.
 */
function account(
  existing: DeployedCredentials = {},
  behavior: Behavior = {},
  processEnv: Record<string, string | undefined> = {},
) {
  const providers = new Map<string, StoredProvider>(
    Object.entries(existing).map(([name, provider]) => [name, { ...provider }]),
  );
  const deleted: string[] = [];
  const optionsSeen: CoreOptions[] = [];

  const lookup = (name: string, options: CoreOptions): StoredProvider => {
    optionsSeen.push(options);
    if (behavior.getFails) throw behavior.getFails;
    const found = providers.get(name);
    if (!found) throw new ResourceNotFoundException({ $metadata: {}, message: "not found" });
    return found;
  };

  const write = (
    kind: ProviderKind,
    name: string,
    config: unknown,
    operation: "created" | "updated",
    options: CoreOptions,
  ): StoredProvider => {
    optionsSeen.push(options);
    if (operation === "created" && behavior.createFailsFor === name) {
      throw new Error(`create ${name} failed`);
    }
    const arns =
      behavior.writeReturns ??
      ({
        credentialProviderArn: `arn:${kind}:${name}`,
        clientSecretArn: `arn:secret:${name}`,
      } satisfies DeployedCredential);
    const stored: StoredProvider = { ...arns, config, operation };
    providers.set(name, stored);
    return stored;
  };

  const remove = (name: string, options: CoreOptions) => {
    optionsSeen.push(options);
    if (behavior.deleteFails) throw behavior.deleteFails;
    providers.delete(name);
    deleted.push(name);
  };

  // The three provider families carry their secret ARN under different response
  // fields, so each maps the stored provider onto its own response shape.
  const asApiKey = (provider: StoredProvider) =>
    ({
      credentialProviderArn: provider.credentialProviderArn,
      ...(provider.clientSecretArn && {
        apiKeySecretArn: { secretArn: provider.clientSecretArn },
      }),
    }) as GetApiKeyCredentialProviderResponse;

  const asOauth2 = (provider: StoredProvider) =>
    ({
      credentialProviderArn: provider.credentialProviderArn,
      ...(provider.clientSecretArn && { clientSecretArn: { secretArn: provider.clientSecretArn } }),
    }) as GetOauth2CredentialProviderResponse;

  const asPayment = (provider: StoredProvider) =>
    ({
      credentialProviderArn: provider.credentialProviderArn,
    }) as GetPaymentCredentialProviderResponse;

  const client: CredentialProviderCalls = {
    async getApiKeyCredentialProvider(name, options) {
      return asApiKey(lookup(name, options));
    },
    async createApiKeyCredentialProvider(input, options) {
      return asApiKey(write("apikey", input.name ?? "", input, "created", options));
    },
    async updateApiKeyCredentialProvider(input, options) {
      return asApiKey(write("apikey", input.name ?? "", input, "updated", options));
    },
    async deleteApiKeyCredentialProvider(name, options) {
      remove(name, options);
      return {};
    },
    async getOauth2CredentialProvider(name, options) {
      return asOauth2(lookup(name, options));
    },
    async createOauth2CredentialProvider(input, options) {
      return asOauth2(write("oauth", input.name ?? "", input, "created", options));
    },
    async updateOauth2CredentialProvider(input, options) {
      return asOauth2(write("oauth", input.name ?? "", input, "updated", options));
    },
    async deleteOauth2CredentialProvider(name, options) {
      remove(name, options);
      return {};
    },
    async getPaymentCredentialProvider(name, options) {
      return asPayment(lookup(name, options));
    },
    async createPaymentCredentialProvider(input, options) {
      return asPayment(write("payment", input.name ?? "", input, "created", options));
    },
    async updatePaymentCredentialProvider(input, options) {
      return asPayment(write("payment", input.name ?? "", input, "updated", options));
    },
    async deletePaymentCredentialProvider(name, options) {
      remove(name, options);
      return {};
    },
  };

  return {
    client,
    deleted,
    optionsSeen,
    provision: createCredentialProvisioner(client, processEnv),
    /** What the account holds once the run is over. */
    contents: () => Object.fromEntries(providers),
    /** The request body a single provider was last written with. */
    configFor: (name: string) => providers.get(name)?.config,
  };
}

async function collect(
  generator: AsyncGenerator<ProjectEvent, void>,
): Promise<{ events: ProjectEvent[] }> {
  const events: ProjectEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events };
    events.push(next.value);
  }
}

async function run(
  provision: CredentialProvisioner,
  input: Project,
): Promise<{ events: ProjectEvent[]; result: DeployedCredentials }> {
  const generator = provision(input, { credentials: CREDENTIALS, region: REGION });
  const events: ProjectEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value as ProjectEvent);
  }
}

/** Drains a provisioning run that is expected to throw, keeping the events it emitted. */
async function runFailing(
  provision: CredentialProvisioner,
  input: Project,
): Promise<{ events: ProjectEvent[]; error: Error }> {
  const generator = provision(input, { credentials: CREDENTIALS, region: REGION });
  const events: ProjectEvent[] = [];
  try {
    while (true) {
      const next = await generator.next();
      if (next.done) throw new Error("expected provisioning to fail");
      events.push(next.value);
    }
  } catch (error) {
    return { events, error: error as Error };
  }
}

const CREATED_OPENAI = {
  credentialProviderArn: "arn:apikey:openai-key",
  clientSecretArn: "arn:secret:openai-key",
};

describe("createCredentialProvisioner", () => {
  test("touches Identity not at all for a project without credentials", async () => {
    const subject = account();

    const { events, result } = await run(subject.provision, await project([]));

    expect(result).toEqual({});
    expect(events).toEqual([]);
    expect(subject.optionsSeen).toEqual([]);
  });

  test("runs every call against the target's own region and credentials", async () => {
    const subject = account();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await run(subject.provision, input);

    expect(subject.optionsSeen.length).toBeGreaterThan(0);
    expect(subject.optionsSeen).toEqual(subject.optionsSeen.map(() => OPTIONS));
  });

  test("creates an API key provider from the secret in .env.local", async () => {
    const subject = account();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    const { events, result } = await run(subject.provision, input);

    expect(events).toEqual([{ message: "Preparing credential provider 'openai-key'" }]);
    expect(subject.contents()).toEqual({
      "openai-key": {
        ...CREATED_OPENAI,
        operation: "created",
        config: { name: "openai-key", apiKey: "sk-live" },
      },
    });
    expect(result).toEqual({ "openai-key": CREATED_OPENAI });
  });

  test("creates an API key provider from a Secrets Manager reference", async () => {
    const secretRef = { secretId: "prod/openai", jsonKey: "apiKey" };
    const subject = account();
    const input = await project([{ ...API_KEY, secretRef }]);

    await run(subject.provision, input);

    expect(subject.configFor("openai-key")).toEqual({
      name: "openai-key",
      apiKeySecretConfig: secretRef,
      apiKeySecretSource: "EXTERNAL",
    });
  });

  test("takes a secret from the environment when .env.local has none", async () => {
    const subject = account({}, {}, { AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-from-env" });
    const input = await project([API_KEY]);

    await run(subject.provision, input);

    expect(subject.configFor("openai-key")).toEqual({
      name: "openai-key",
      apiKey: "sk-from-env",
    });
  });

  test("prefers the environment over .env.local, ignoring unrelated variables", async () => {
    const subject = account(
      {},
      {},
      { AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-from-env", HOME: "/should/not/matter" },
    );
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-from-file'\n");

    await run(subject.provision, input);

    expect(subject.configFor("openai-key")).toEqual({
      name: "openai-key",
      apiKey: "sk-from-env",
    });
  });

  test("names the variable and file to fix when an API key secret is missing", async () => {
    const subject = account();
    const input = await project([API_KEY]);

    await expect(run(subject.provision, input)).rejects.toThrow(
      new RegExp(
        `AGENTCORE_CREDENTIAL_OPENAI_KEY[\\s\\S]*${join(input.rootPath, "agentcore", ".env.local").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*secretRef`,
      ),
    );
  });

  test("updates a provider that already exists with the current secret", async () => {
    const subject = account({
      "openai-key": { credentialProviderArn: "arn:existing", clientSecretArn: "arn:existing/s" },
    });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-rotated'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.contents()).toEqual({
      "openai-key": {
        ...CREATED_OPENAI,
        operation: "updated",
        config: { name: "openai-key", apiKey: "sk-rotated" },
      },
    });
    expect(result).toEqual({ "openai-key": CREATED_OPENAI });
  });

  test("updates an existing OAuth provider with the current client secret", async () => {
    const subject = account({ "my-oauth": { credentialProviderArn: "arn:existing" } });
    const input = await project([OAUTH], "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='rotated'\n");

    await run(subject.provision, input);

    expect(subject.contents()["my-oauth"]?.operation).toBe("updated");
    expect(subject.configFor("my-oauth")).toEqual({
      name: "my-oauth",
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          oauthDiscovery: { discoveryUrl: DISCOVERY },
          clientId: "client-1",
          clientSecret: "rotated",
        },
      },
    });
  });

  test("leaves an existing provider alone when no secret is available locally", async () => {
    const existing = { credentialProviderArn: "arn:existing", clientSecretArn: "arn:existing/s" };
    const subject = account({ "openai-key": existing });
    // No .env.local entry and no secretRef: there is nothing to push, so the
    // provider keeps whatever secret it holds rather than failing the deploy.
    const input = await project([API_KEY]);

    const { result } = await run(subject.provision, input);

    // Untouched: no operation recorded against it, and its ARNs are the ones it had.
    expect(subject.contents()).toEqual({ "openai-key": existing });
    expect(result).toEqual({ "openai-key": existing });
  });

  test("updates a provider backed by an external secret reference", async () => {
    const secretRef = { secretId: "prod/openai", jsonKey: "apiKey" };
    const subject = account({ "openai-key": { credentialProviderArn: "arn:existing" } });
    const input = await project([{ ...API_KEY, secretRef }]);

    await run(subject.provision, input);

    expect(subject.contents()["openai-key"]?.operation).toBe("updated");
    expect(subject.configFor("openai-key")).toEqual({
      name: "openai-key",
      apiKeySecretConfig: secretRef,
      apiKeySecretSource: "EXTERNAL",
    });
  });

  test("records a provider that has no secret ARN without one", async () => {
    const subject = account({ "openai-key": { credentialProviderArn: "arn:existing" } });
    const input = await project([API_KEY]);

    const { result } = await run(subject.provision, input);

    expect(result).toEqual({ "openai-key": { credentialProviderArn: "arn:existing" } });
  });

  test("fails when Identity returns a provider without an ARN", async () => {
    const subject = account({}, { writeReturns: {} as DeployedCredential });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await expect(run(subject.provision, input)).rejects.toThrow(/no credentialProviderArn/);
  });

  test("propagates a lookup failure that is not a missing provider", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    const subject = account({}, { getFails: denied });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await expect(run(subject.provision, input)).rejects.toBe(denied);
  });

  test("creates a guided OAuth2 provider without forwarding scopes", async () => {
    const subject = account();
    const input = await project([OAUTH], "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='shh'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.contents()["my-oauth"]?.operation).toBe("created");
    expect(subject.configFor("my-oauth")).toEqual({
      name: "my-oauth",
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          oauthDiscovery: { discoveryUrl: DISCOVERY },
          clientId: "client-1",
          clientSecret: "shh",
        },
      },
    });
    expect(result["my-oauth"]).toEqual({
      credentialProviderArn: "arn:oauth:my-oauth",
      clientSecretArn: "arn:secret:my-oauth",
    });
  });

  test("falls back to the legacy _CLIENT_ID variable when the spec has no clientId", async () => {
    const subject = account();
    // An older CLI kept the client id in .env.local, not agentcore.json.
    const { clientId: _dropped, ...withoutClientId } = OAUTH;
    const input = await project(
      [withoutClientId],
      "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='shh'\n" +
        "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_ID='legacy-client'\n",
    );

    await run(subject.provision, input);

    expect(subject.configFor("my-oauth")).toEqual({
      name: "my-oauth",
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          oauthDiscovery: { discoveryUrl: DISCOVERY },
          clientId: "legacy-client",
          clientSecret: "shh",
        },
      },
    });
  });

  test("injects the secret into a spec-supplied provider config", async () => {
    const subject = account();
    const input = await project(
      [
        {
          authorizerType: "OAuthCredentialProvider",
          name: "vendored",
          vendor: "GoogleOauth2",
          providerConfig: {
            googleOauth2ProviderConfig: { clientId: "google-client" },
          },
        },
      ],
      "AGENTCORE_CREDENTIAL_VENDORED_CLIENT_SECRET='g-secret'\n",
    );

    await run(subject.provision, input);

    expect(subject.configFor("vendored")).toEqual({
      name: "vendored",
      credentialProviderVendor: "GoogleOauth2",
      oauth2ProviderConfigInput: {
        googleOauth2ProviderConfig: { clientId: "google-client", clientSecret: "g-secret" },
      },
    });
  });

  test("passes an OAuth secret reference through as an external secret", async () => {
    const clientSecretRef = { secretId: "prod/oauth", jsonKey: "clientSecret" };
    const subject = account();
    const input = await project([{ ...OAUTH, clientSecretRef }]);

    await run(subject.provision, input);

    expect(subject.configFor("my-oauth")).toEqual({
      name: "my-oauth",
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          oauthDiscovery: { discoveryUrl: DISCOVERY },
          clientId: "client-1",
          clientSecretConfig: clientSecretRef,
          clientSecretSource: "EXTERNAL",
        },
      },
    });
  });

  test("rejects a provider config that is not a single vendor object", async () => {
    const subject = account();
    const input = await project(
      [
        {
          authorizerType: "OAuthCredentialProvider",
          name: "two-vendors",
          vendor: "GoogleOauth2",
          providerConfig: {
            googleOauth2ProviderConfig: { clientId: "a" },
            githubOauth2ProviderConfig: { clientId: "b" },
          },
        },
      ],
      "AGENTCORE_CREDENTIAL_TWO_VENDORS_CLIENT_SECRET='s'\n",
    );

    await expect(run(subject.provision, input)).rejects.toThrow(/exactly one vendor config object/);
  });

  test("creates a Coinbase payment provider from the vendor's variables", async () => {
    const subject = account();
    const input = await project(
      [COINBASE],
      "AGENTCORE_CREDENTIAL_WALLET_API_KEY_ID='key-1'\n" +
        "AGENTCORE_CREDENTIAL_WALLET_API_KEY_SECRET='key-secret'\n" +
        "AGENTCORE_CREDENTIAL_WALLET_WALLET_SECRET='wallet-secret'\n",
    );

    const { result } = await run(subject.provision, input);

    expect(subject.contents()["wallet"]?.operation).toBe("created");
    expect(subject.configFor("wallet")).toEqual({
      name: "wallet",
      credentialProviderVendor: "CoinbaseCDP",
      providerConfigurationInput: {
        coinbaseCdpConfiguration: {
          apiKeyId: "key-1",
          apiKeySecret: "key-secret",
          walletSecret: "wallet-secret",
        },
      },
    });
    // A payment provider holds several secrets, each under its own vendor field, so
    // only the provider ARN is recorded.
    expect(result).toEqual({ wallet: { credentialProviderArn: "arn:payment:wallet" } });
  });

  test("updates an existing StripePrivy payment provider", async () => {
    const subject = account({ pay: { credentialProviderArn: "arn:existing" } });
    const input = await project(
      [{ authorizerType: "PaymentCredentialProvider", name: "pay", provider: "StripePrivy" }],
      "AGENTCORE_CREDENTIAL_PAY_APP_ID='app-1'\n" +
        "AGENTCORE_CREDENTIAL_PAY_APP_SECRET='app-secret'\n" +
        "AGENTCORE_CREDENTIAL_PAY_AUTHORIZATION_PRIVATE_KEY='priv-key'\n" +
        "AGENTCORE_CREDENTIAL_PAY_AUTHORIZATION_ID='auth-1'\n",
    );

    await run(subject.provision, input);

    expect(subject.contents()["pay"]?.operation).toBe("updated");
    expect(subject.configFor("pay")).toEqual({
      name: "pay",
      credentialProviderVendor: "StripePrivy",
      providerConfigurationInput: {
        stripePrivyConfiguration: {
          appId: "app-1",
          appSecret: "app-secret",
          authorizationPrivateKey: "priv-key",
          authorizationId: "auth-1",
        },
      },
    });
  });

  test("names every payment variable that is unset", async () => {
    const subject = account();
    const input = await project([COINBASE], "AGENTCORE_CREDENTIAL_WALLET_API_KEY_ID='key-1'\n");

    await expect(run(subject.provision, input)).rejects.toThrow(
      /AGENTCORE_CREDENTIAL_WALLET_API_KEY_SECRET, AGENTCORE_CREDENTIAL_WALLET_WALLET_SECRET/,
    );
  });

  test("leaves an existing payment provider alone when its variables are unset", async () => {
    const existing = { credentialProviderArn: "arn:existing" };
    const subject = account({ wallet: existing });
    const input = await project([COINBASE]);

    const { result } = await run(subject.provision, input);

    expect(subject.contents()).toEqual({ wallet: existing });
    expect(result).toEqual({ wallet: existing });
  });

  test("creates nothing when a later credential's secret is missing", async () => {
    const subject = account();
    // First credential's secret is present; the second's is not.
    const input = await project(
      [API_KEY, { authorizerType: "ApiKeyCredentialProvider", name: "other-key" }],
      "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n",
    );

    await expect(run(subject.provision, input)).rejects.toThrow(/AGENTCORE_CREDENTIAL_OTHER_KEY/);
    // The missing secret is caught before the first create, so the account is
    // untouched rather than half-provisioned.
    expect(subject.contents()).toEqual({});
  });
});

describe("createCredentialProvisioner rollback", () => {
  const TWO_KEYS = [API_KEY, { authorizerType: "ApiKeyCredentialProvider", name: "other-key" }];
  const BOTH_SECRETS =
    "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n" + "AGENTCORE_CREDENTIAL_OTHER_KEY='sk-other'\n";

  test("deletes what it created when a later provider fails", async () => {
    const subject = account({}, { createFailsFor: "other-key" });
    const input = await project(TWO_KEYS, BOTH_SECRETS);

    // The failure the user needs to see is the one that stopped the deploy.
    const { error } = await runFailing(subject.provision, input);

    expect(error.message).toMatch(/create other-key failed/);
    expect(subject.deleted).toEqual(["openai-key"]);
    expect(subject.contents()).toEqual({});
  });

  test("does not delete a provider it only updated", async () => {
    const subject = account(
      { "openai-key": { credentialProviderArn: "arn:existing" } },
      { createFailsFor: "other-key" },
    );
    const input = await project(TWO_KEYS, BOTH_SECRETS);

    const { error } = await runFailing(subject.provision, input);

    expect(error.message).toMatch(/create other-key failed/);
    // Undoing an update would need the secret the provider held before, which the
    // CLI never had, so the pre-existing provider is left as this deploy set it.
    expect(subject.deleted).toEqual([]);
    expect(subject.contents()["openai-key"]?.operation).toBe("updated");
  });

  test("reports a provider it created but could not delete", async () => {
    const subject = account(
      {},
      { createFailsFor: "other-key", deleteFails: new Error("access denied") },
    );
    const input = await project(TWO_KEYS, BOTH_SECRETS);

    const { events, error } = await runFailing(subject.provision, input);

    expect(error.message).toMatch(/create other-key failed/);
    expect(events.map((event) => event.message)).toContain(
      "Removing credential provider 'openai-key' this deploy created",
    );
    expect(events[events.length - 1]?.message).toMatch(
      /Could not remove credential provider 'openai-key'.*access denied.*next deploy/s,
    );
    // The provider it could not delete is still there, which is what the message says.
    expect(subject.contents()["openai-key"]?.operation).toBe("created");
  });
});

describe("createPaymentCredentialRemover", () => {
  test("deletes only the payment providers a torn-down project declares", async () => {
    const apiKeyProvider = { credentialProviderArn: "arn:apikey:openai-key" };
    const subject = account({
      "openai-key": apiKeyProvider,
      wallet: { credentialProviderArn: "arn:payment:wallet" },
    });
    const input = await project([API_KEY, COINBASE]);

    const remove = createPaymentCredentialRemover(subject.client);
    const { events } = await collect(remove(input, { credentials: CREDENTIALS, region: REGION }));

    // The api-key provider is named account-globally and may be shared, so it stays.
    expect(subject.contents()).toEqual({ "openai-key": apiKeyProvider });
    expect(subject.deleted).toEqual(["wallet"]);
    expect(events).toEqual([{ message: "Removing credential provider 'wallet'" }]);
    expect(subject.optionsSeen).toEqual([OPTIONS]);
  });

  test("treats a payment provider that is already gone as removed", async () => {
    const notFound = new ResourceNotFoundException({ $metadata: {}, message: "not found" });
    const subject = account({}, { deleteFails: notFound });
    const input = await project([COINBASE]);

    const remove = createPaymentCredentialRemover(subject.client);
    const { events } = await collect(remove(input, { credentials: CREDENTIALS, region: REGION }));

    expect(events).toEqual([{ message: "Removing credential provider 'wallet'" }]);
  });

  test("reports a payment provider it could not delete rather than failing", async () => {
    const existing = { credentialProviderArn: "arn:payment:wallet" };
    const subject = account({ wallet: existing }, { deleteFails: new Error("still in use") });
    const input = await project([COINBASE]);

    const remove = createPaymentCredentialRemover(subject.client);
    const { events } = await collect(remove(input, { credentials: CREDENTIALS, region: REGION }));

    expect(events[1]?.message).toMatch(/Could not remove credential provider 'wallet'.*in use/);
    expect(subject.contents()).toEqual({ wallet: existing });
  });
});
