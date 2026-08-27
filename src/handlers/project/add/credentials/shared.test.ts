import { describe, expect, test } from "bun:test";
import { credentialSecretEnvKey } from "./shared";

describe("credentialSecretEnvKey", () => {
  test("API keys use the base variable; OAuth appends the client-secret suffix", () => {
    expect(
      credentialSecretEnvKey({ authorizerType: "ApiKeyCredentialProvider", name: "openai" }),
    ).toBe("AGENTCORE_CREDENTIAL_OPENAI");
    expect(
      credentialSecretEnvKey({
        authorizerType: "OAuthCredentialProvider",
        name: "openai",
        vendor: "CustomOauth2",
      }),
    ).toBe("AGENTCORE_CREDENTIAL_OPENAI_CLIENT_SECRET");
  });

  test("an OAuth name collides with an API key named like it + client_secret", () => {
    // The bug this guards: both resolve to the same .env.local variable.
    const oauth = credentialSecretEnvKey({
      authorizerType: "OAuthCredentialProvider",
      name: "foo",
      vendor: "CustomOauth2",
    });
    const apiKey = credentialSecretEnvKey({
      authorizerType: "ApiKeyCredentialProvider",
      name: "foo_client_secret",
    });
    expect(oauth).toBe("AGENTCORE_CREDENTIAL_FOO_CLIENT_SECRET");
    expect(apiKey).toBe(oauth);
  });

  test("credentials backed by an external secret reference have no .env.local variable", () => {
    expect(
      credentialSecretEnvKey({
        authorizerType: "ApiKeyCredentialProvider",
        name: "openai",
        secretRef: { secretId: "s", jsonKey: "k" },
      }),
    ).toBeUndefined();
    expect(
      credentialSecretEnvKey({
        authorizerType: "OAuthCredentialProvider",
        name: "openai",
        vendor: "CustomOauth2",
        clientSecretRef: { secretId: "s", jsonKey: "k" },
      }),
    ).toBeUndefined();
  });

  test("payment credentials have no .env.local variable", () => {
    expect(
      credentialSecretEnvKey({
        authorizerType: "PaymentCredentialProvider",
        name: "pay",
        provider: "StripePrivy",
      }),
    ).toBeUndefined();
  });
});
