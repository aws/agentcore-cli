import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { EnvLocalFile } from "../../envLocal";
import {
  createCredentialProvisioner,
  type CredentialProvisioner,
  type DeployedCredential,
  type DeployedCredentials,
  type IdentityProviderClient,
} from "./credentials";
import type { CdkCredentialProvider } from "./toolkit";

const REGION = "us-east-1";
const CREDENTIALS: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

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

type Call = { kind: string; input: unknown };

function identity(existing: DeployedCredentials = {}) {
  const calls: Call[] = [];
  const factoryArgs: { region: string; credentials: CdkCredentialProvider }[] = [];

  const created = (name: string, prefix: string): DeployedCredential => ({
    credentialProviderArn: `arn:${prefix}:${name}`,
    clientSecretArn: `arn:secret:${name}`,
  });

  const client: IdentityProviderClient = {
    async getApiKeyProvider(name) {
      calls.push({ kind: "getApiKey", input: name });
      return existing[name];
    },
    async createApiKeyProvider(input) {
      calls.push({ kind: "createApiKey", input });
      return created(input.name, "apikey");
    },
    async getOauth2Provider(name) {
      calls.push({ kind: "getOauth2", input: name });
      return existing[name];
    },
    async createOauth2Provider(input) {
      calls.push({ kind: "createOauth2", input });
      return created(input.name, "oauth");
    },
  };

  return {
    calls,
    factoryArgs,
    provision: createCredentialProvisioner(async (region, credentials) => {
      factoryArgs.push({ region, credentials });
      return client;
    }),
  };
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
  test("does not build a client for a project without credentials", async () => {
    const subject = identity();

    const { events, result } = await run(subject.provision, await project([]));

    expect(result).toEqual({});
    expect(events).toEqual([]);
    expect(subject.factoryArgs).toEqual([]);
  });

  test("builds the client against the target's own region and credentials", async () => {
    const subject = identity();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    await run(subject.provision, input);

    expect(subject.factoryArgs).toEqual([{ region: REGION, credentials: CREDENTIALS }]);
  });

  test("creates an API key provider from the secret in .env.local", async () => {
    const subject = identity();
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    const { events, result } = await run(subject.provision, input);

    expect(events).toEqual([{ message: "Preparing credential provider 'openai-key'" }]);
    expect(subject.calls).toEqual([
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

    expect(subject.calls).toEqual([
      { kind: "getApiKey", input: "openai-key" },
      { kind: "createApiKey", input: { name: "openai-key", secretRef } },
    ]);
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

  test("reuses a provider that already exists instead of recreating it", async () => {
    const existing = { credentialProviderArn: "arn:existing", clientSecretArn: "arn:existing/s" };
    const subject = identity({ "openai-key": existing });
    const input = await project([API_KEY], "AGENTCORE_CREDENTIAL_OPENAI_KEY='sk-live'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.calls).toEqual([{ kind: "getApiKey", input: "openai-key" }]);
    expect(result).toEqual({ "openai-key": existing });
  });

  test("creates a guided OAuth2 provider without forwarding scopes", async () => {
    const subject = identity();
    const input = await project([OAUTH], "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET='shh'\n");

    const { result } = await run(subject.provision, input);

    expect(subject.calls).toEqual([
      { kind: "getOauth2", input: "my-oauth" },
      {
        kind: "createOauth2",
        input: {
          name: "my-oauth",
          vendor: "CustomOauth2",
          config: {
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

    expect(subject.calls[1]).toEqual({
      kind: "createOauth2",
      input: {
        name: "my-oauth",
        vendor: "CustomOauth2",
        config: {
          customOauth2ProviderConfig: {
            oauthDiscovery: { discoveryUrl: DISCOVERY },
            clientId: "legacy-client",
            clientSecret: "shh",
          },
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

    expect(subject.calls[1]).toEqual({
      kind: "createOauth2",
      input: {
        name: "vendored",
        vendor: "GoogleOauth2",
        config: {
          googleOauth2ProviderConfig: { clientId: "google-client", clientSecret: "g-secret" },
        },
      },
    });
  });

  test("passes an OAuth secret reference through as an external secret", async () => {
    const clientSecretRef = { secretId: "prod/oauth", jsonKey: "clientSecret" };
    const subject = identity();
    const input = await project([{ ...OAUTH, clientSecretRef }]);

    await run(subject.provision, input);

    expect(subject.calls[1]).toEqual({
      kind: "createOauth2",
      input: {
        name: "my-oauth",
        vendor: "CustomOauth2",
        config: {
          customOauth2ProviderConfig: {
            oauthDiscovery: { discoveryUrl: DISCOVERY },
            clientId: "client-1",
            clientSecretConfig: clientSecretRef,
            clientSecretSource: "EXTERNAL",
          },
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
