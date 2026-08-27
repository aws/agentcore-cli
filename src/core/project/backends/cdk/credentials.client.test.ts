import { afterEach, describe, expect, mock, test } from "bun:test";

// credentials.test.ts drives the provisioner with a fake client; this covers the
// real factory by mocking the AWS SDK it lazily imports.

class ResourceNotFoundException extends Error {
  constructor() {
    super("not found");
    this.name = "ResourceNotFoundException";
  }
}
class GetApiKeyCredentialProviderCommand {
  constructor(readonly input: unknown) {}
}
class CreateApiKeyCredentialProviderCommand {
  constructor(readonly input: unknown) {}
}
class GetOauth2CredentialProviderCommand {
  constructor(readonly input: unknown) {}
}
class CreateOauth2CredentialProviderCommand {
  constructor(readonly input: unknown) {}
}

const sent: unknown[] = [];
let send: (command: unknown) => Promise<unknown>;

class BedrockAgentCoreControlClient {
  constructor(readonly config: unknown) {}
  send(command: unknown) {
    sent.push(command);
    return send(command);
  }
}

mock.module("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient,
  GetApiKeyCredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  CreateOauth2CredentialProviderCommand,
  ResourceNotFoundException,
}));

const { createIdentityProviderClient } = await import("./credentials");
const credentials = async () => ({ accessKeyId: "a", secretAccessKey: "b" });

afterEach(() => {
  sent.length = 0;
});

describe("createIdentityProviderClient", () => {
  test("passes region and credentials to the SDK client", async () => {
    send = async () => ({ credentialProviderArn: "arn:cp" });
    const client = await createIdentityProviderClient("eu-west-1", credentials);
    await client.getApiKeyProvider("k");

    expect((sent[0] as GetApiKeyCredentialProviderCommand).input).toEqual({ name: "k" });
  });

  test("maps an API key provider, including its secret ARN", async () => {
    send = async () => ({
      credentialProviderArn: "arn:cp",
      apiKeySecretArn: { secretArn: "arn:secret" },
    });
    const client = await createIdentityProviderClient("us-east-1", credentials);

    expect(await client.getApiKeyProvider("k")).toEqual({
      credentialProviderArn: "arn:cp",
      clientSecretArn: "arn:secret",
    });
  });

  test("returns undefined when the provider does not exist", async () => {
    send = async () => {
      throw new ResourceNotFoundException();
    };
    const client = await createIdentityProviderClient("us-east-1", credentials);

    expect(await client.getApiKeyProvider("missing")).toBeUndefined();
    expect(await client.getOauth2Provider("missing")).toBeUndefined();
  });

  test("propagates errors other than not-found", async () => {
    const failure = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    send = async () => {
      throw failure;
    };
    const client = await createIdentityProviderClient("us-east-1", credentials);

    await expect(client.getApiKeyProvider("k")).rejects.toBe(failure);
  });

  test("throws when Identity returns no provider ARN", async () => {
    send = async () => ({});
    const client = await createIdentityProviderClient("us-east-1", credentials);

    await expect(client.createApiKeyProvider({ name: "k", apiKey: "sk" })).rejects.toThrow(
      /no credentialProviderArn/,
    );
  });

  test("creates an API key provider from an inline key", async () => {
    send = async () => ({ credentialProviderArn: "arn:cp" });
    const client = await createIdentityProviderClient("us-east-1", credentials);

    await client.createApiKeyProvider({ name: "k", apiKey: "sk-live" });

    expect((sent[0] as CreateApiKeyCredentialProviderCommand).input).toEqual({
      name: "k",
      apiKey: "sk-live",
    });
  });

  test("creates an API key provider from an external secret reference", async () => {
    send = async () => ({ credentialProviderArn: "arn:cp" });
    const client = await createIdentityProviderClient("us-east-1", credentials);

    const secretRef = { secretId: "s", jsonKey: "apiKey" };
    await client.createApiKeyProvider({ name: "k", secretRef });

    expect((sent[0] as CreateApiKeyCredentialProviderCommand).input).toEqual({
      name: "k",
      apiKeySecretConfig: secretRef,
      apiKeySecretSource: "EXTERNAL",
    });
  });

  test("creates an OAuth2 provider with its vendor and config", async () => {
    send = async () => ({
      credentialProviderArn: "arn:cp",
      clientSecretArn: { secretArn: "arn:secret" },
    });
    const client = await createIdentityProviderClient("us-east-1", credentials);

    const config = { customOauth2ProviderConfig: { oauthDiscovery: { discoveryUrl: "u" } } };
    const result = await client.createOauth2Provider({ name: "o", vendor: "CustomOauth2", config });

    expect((sent[0] as CreateOauth2CredentialProviderCommand).input).toEqual({
      name: "o",
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: config,
    });
    expect(result).toEqual({ credentialProviderArn: "arn:cp", clientSecretArn: "arn:secret" });
  });
});
