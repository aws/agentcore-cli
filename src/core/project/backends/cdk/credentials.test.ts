import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResourceNotFoundException,
  type CreateApiKeyCredentialProviderResponse,
  type CreateOauth2CredentialProviderResponse,
  type GetApiKeyCredentialProviderResponse,
  type GetOauth2CredentialProviderResponse,
  type UpdateApiKeyCredentialProviderResponse,
  type UpdateOauth2CredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { CoreOptions } from "../../../types";
import { EnvLocalFile } from "../../envLocal";
import {
  createCredentialProvisioner,
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

type Call = { kind: string; input: unknown; options: CoreOptions };

// Identity reports a provider that does not exist by throwing, which is the normal
// first-deploy case rather than a failure.
const notFound = () =>
  new ResourceNotFoundException({ $metadata: {}, message: "provider not found" });

// The two provider families carry their secret ARN under different response fields.
const apiKeyResponse = (provider: DeployedCredential | undefined) =>
  ({
    credentialProviderArn: provider?.credentialProviderArn,
    ...(provider?.clientSecretArn && { apiKeySecretArn: { secretArn: provider.clientSecretArn } }),
  }) as GetApiKeyCredentialProviderResponse &
    CreateApiKeyCredentialProviderResponse &
    UpdateApiKeyCredentialProviderResponse;

const oauth2Response = (provider: DeployedCredential | undefined) =>
  ({
    credentialProviderArn: provider?.credentialProviderArn,
    ...(provider?.clientSecretArn && { clientSecretArn: { secretArn: provider.clientSecretArn } }),
  }) as GetOauth2CredentialProviderResponse &
    CreateOauth2CredentialProviderResponse &
    UpdateOauth2CredentialProviderResponse;

/** Overrides for the paths that only a failing or incomplete Identity produces. */
type Behavior = {
  /** Thrown by every lookup, in place of the not-found default. */
  getFails?: Error;
  /** Returned by every create, in place of a fully populated provider. */
  createReturns?: DeployedCredential;
};

function identity(
  existing: DeployedCredentials = {},
  behavior: Behavior = {},
  processEnv: Record<string, string | undefined> = {},
) {
  const calls: Call[] = [];

  const created = (name: string, prefix: string): DeployedCredential =>
    behavior.createReturns ?? {
      credentialProviderArn: `arn:${prefix}:${name}`,
      clientSecretArn: `arn:secret:${name}`,
    };

  const lookup = (name: string): DeployedCredential => {
    if (behavior.getFails) throw behavior.getFails;
    const found = existing[name];
    if (!found) throw notFound();
    return found;
  };

  const client: CredentialProviderCalls = {
    async getApiKeyCredentialProvider(name, options) {
      calls.push({ kind: "getApiKey", input: name, options });
      return apiKeyResponse(lookup(name));
    },
    async createApiKeyCredentialProvider(input, options) {
      calls.push({ kind: "createApiKey", input, options });
      return apiKeyResponse(created(input.name ?? "", "apikey"));
    },
    async updateApiKeyCredentialProvider(input, options) {
      calls.push({ kind: "updateApiKey", input, options });
      return apiKeyResponse(created(input.name ?? "", "apikey"));
    },
    async getOauth2CredentialProvider(name, options) {
      calls.push({ kind: "getOauth2", input: name, options });
      return oauth2Response(lookup(name));
    },
    async createOauth2CredentialProvider(input, options) {
      calls.push({ kind: "createOauth2", input, options });
      return oauth2Response(created(input.name ?? "", "oauth"));
    },
    async updateOauth2CredentialProvider(input, options) {
      calls.push({ kind: "updateOauth2", input, options });
      return oauth2Response(created(input.name ?? "", "oauth"));
    },
  };

  return { calls, provision: createCredentialProvisioner(client, processEnv) };
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

describe("createCredentialProvisioner", () => {
  test("calls Identity not at all for a project without credentials", async () => {
    const subject = identity();

    const { events, result } = await run(subject.provision, await project([]));

    expect(result).toEqual({});
    expect(events).toEqual([]);
    expect(subject.calls).toEqual([]);
  });

  test("runs every call against the target's own region and credentials", async () => {
    const subject = identity();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await run(subject.provision, input);

    expect(subject.calls.map((call) => call.options)).toEqual([OPTIONS, OPTIONS]);
  });

  test("creates an API key provider from the secret in .env.local", async () => {
    const subject = identity();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    const { events, result } = await run(subject.provision, input);

    expect(events).toEqual([{ message: "Preparing credential provider 'openai-key'" }]);
    expect(subject.calls.map(({ kind, input: called }) => ({ kind, input: called }))).toEqual([
      { kind: "getApiKey", input: "openai-key" },
      { kind: "createApiKey", input: { name: "openai-key", apiKey: "sk-live" } },
    ]);
    expect(result).toEqual({
      "openai-key": {
        credentialProviderArn: "arn:apikey:openai-key",
        clientSecretArn: "arn:secret:openai-key",
      },
    });
  });

  test("creates an API key provider from a Secrets Manager reference", async () => {
    const secretRef = { secretId: "prod/openai", jsonKey: "apiKey" };
    const subject = identity();
    const input = await project([{ ...API_KEY, secretRef }]);

    await run(subject.provision, input);

    expect(subject.calls[1]?.input).toEqual({
      name: "openai-key",
      apiKeySecretConfig: secretRef,
      apiKeySecretSource: "EXTERNAL",
    });
  });

  test("takes a secret from the environment when .env.local has none", async () => {
    const subject = identity({}, {}, { AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-from-env" });
    const input = await project([API_KEY]);

    await run(subject.provision, input);

    expect(subject.calls[1]?.input).toEqual({ name: "openai-key", apiKey: "sk-from-env" });
  });

  test("prefers the environment over .env.local, ignoring unrelated variables", async () => {
    const subject = identity(
      {},
      {},
      { AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-from-env", HOME: "/should/not/matter" },
    );
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-from-file'\n");

    await run(subject.provision, input);

    expect(subject.calls[1]?.input).toEqual({ name: "openai-key", apiKey: "sk-from-env" });
  });

  test("names the variable and file to fix when an API key secret is missing", async () => {
    const subject = identity();
    const input = await project([API_KEY]);

    await expect(run(subject.provision, input)).rejects.toThrow(
      new RegExp(
        `AGENTCORE_CREDENTIAL_OPENAI_KEY[\\s\\S]*${join(input.rootPath, "agentcore", ".env.local").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*secretRef`,
      ),
    );
  });

  test("updates a provider that already exists with the current secret", async () => {
    const existing = { credentialProviderArn: "arn:existing", clientSecretArn: "arn:existing/s" };
    const subject = identity({ "openai-key": existing });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-rotated'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.calls.map((call) => call.kind)).toEqual(["getApiKey", "updateApiKey"]);
    expect(subject.calls[1]?.input).toEqual({ name: "openai-key", apiKey: "sk-rotated" });
    expect(result).toEqual({
      "openai-key": {
        credentialProviderArn: "arn:apikey:openai-key",
        clientSecretArn: "arn:secret:openai-key",
      },
    });
  });

  test("updates an existing OAuth provider with the current client secret", async () => {
    const subject = identity({ "my-oauth": { credentialProviderArn: "arn:existing" } });
    const input = await project([OAUTH], "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='rotated'\n");

    await run(subject.provision, input);

    expect(subject.calls.map((call) => call.kind)).toEqual(["getOauth2", "updateOauth2"]);
    expect(subject.calls[1]?.input).toEqual({
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
    const subject = identity({ "openai-key": existing });
    // No .env.local entry and no secretRef: there is nothing to push, so the
    // provider keeps whatever secret it holds rather than failing the deploy.
    const input = await project([API_KEY]);

    const { result } = await run(subject.provision, input);

    expect(subject.calls.map((call) => call.kind)).toEqual(["getApiKey"]);
    expect(result).toEqual({ "openai-key": existing });
  });

  test("updates a provider backed by an external secret reference", async () => {
    const secretRef = { secretId: "prod/openai", jsonKey: "apiKey" };
    const subject = identity({ "openai-key": { credentialProviderArn: "arn:existing" } });
    const input = await project([{ ...API_KEY, secretRef }]);

    await run(subject.provision, input);

    expect(subject.calls.map((call) => call.kind)).toEqual(["getApiKey", "updateApiKey"]);
    expect(subject.calls[1]?.input).toEqual({
      name: "openai-key",
      apiKeySecretConfig: secretRef,
      apiKeySecretSource: "EXTERNAL",
    });
  });

  test("records a provider that has no secret ARN without one", async () => {
    const subject = identity({ "openai-key": { credentialProviderArn: "arn:existing" } });
    const input = await project([API_KEY]);

    const { result } = await run(subject.provision, input);

    expect(result).toEqual({ "openai-key": { credentialProviderArn: "arn:existing" } });
  });

  test("fails when Identity returns a provider without an ARN", async () => {
    const subject = identity({}, { createReturns: {} as DeployedCredential });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await expect(run(subject.provision, input)).rejects.toThrow(/no credentialProviderArn/);
  });

  test("propagates a lookup failure that is not a missing provider", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    const subject = identity({}, { getFails: denied });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await expect(run(subject.provision, input)).rejects.toBe(denied);
  });

  test("creates a guided OAuth2 provider without forwarding scopes", async () => {
    const subject = identity();
    const input = await project([OAUTH], "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='shh'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.calls.map(({ kind, input: called }) => ({ kind, input: called }))).toEqual([
      { kind: "getOauth2", input: "my-oauth" },
      {
        kind: "createOauth2",
        input: {
          name: "my-oauth",
          credentialProviderVendor: "CustomOauth2",
          oauth2ProviderConfigInput: {
            customOauth2ProviderConfig: {
              oauthDiscovery: { discoveryUrl: DISCOVERY },
              clientId: "client-1",
              clientSecret: "shh",
            },
          },
        },
      },
    ]);
    expect(result["my-oauth"]).toEqual({
      credentialProviderArn: "arn:oauth:my-oauth",
      clientSecretArn: "arn:secret:my-oauth",
    });
  });

  test("falls back to the legacy _CLIENT_ID variable when the spec has no clientId", async () => {
    const subject = identity();
    // An older CLI kept the client id in .env.local, not agentcore.json.
    const { clientId: _dropped, ...withoutClientId } = OAUTH;
    const input = await project(
      [withoutClientId],
      "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='shh'\n" +
        "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_ID='legacy-client'\n",
    );

    await run(subject.provision, input);

    expect(subject.calls[1]?.input).toEqual({
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
    const subject = identity();
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

    expect(subject.calls[1]?.input).toEqual({
      name: "vendored",
      credentialProviderVendor: "GoogleOauth2",
      oauth2ProviderConfigInput: {
        googleOauth2ProviderConfig: { clientId: "google-client", clientSecret: "g-secret" },
      },
    });
  });

  test("passes an OAuth secret reference through as an external secret", async () => {
    const clientSecretRef = { secretId: "prod/oauth", jsonKey: "clientSecret" };
    const subject = identity();
    const input = await project([{ ...OAUTH, clientSecretRef }]);

    await run(subject.provision, input);

    expect(subject.calls[1]?.input).toEqual({
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
    const subject = identity();
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

  test("rejects a payment credential before creating any provider", async () => {
    const subject = identity();
    const input = await project(
      [
        API_KEY,
        { authorizerType: "PaymentCredentialProvider", name: "pay-1", provider: "StripePrivy" },
      ],
      "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n",
    );

    await expect(run(subject.provision, input)).rejects.toThrow(
      /PaymentCredentialProvider, which 'agentcore project deploy' cannot create/,
    );
    expect(subject.calls).toEqual([]);
  });

  test("creates nothing when a later credential's secret is missing", async () => {
    const subject = identity();
    // First credential's secret is present; the second's is not.
    const input = await project(
      [API_KEY, { authorizerType: "ApiKeyCredentialProvider", name: "other-key" }],
      "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n",
    );

    await expect(run(subject.provision, input)).rejects.toThrow(/AGENTCORE_CREDENTIAL_OTHER_KEY/);
    // Both looked up, but no provider was created — the missing secret is caught
    // before the first create, so there is no half-provisioned AWS state.
    expect(subject.calls.map((c) => c.kind)).toEqual(["getApiKey", "getApiKey"]);
  });
});
