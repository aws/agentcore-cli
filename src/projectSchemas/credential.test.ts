import { describe, expect, it } from "bun:test";
import { CredentialSchema } from "./credential";

const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";
const SECRET_REF = {
  secretId: "arn:aws:secretsmanager:us-west-2:123456789012:secret:s",
  jsonKey: "value",
};

describe("credential schema", () => {
  it.each<[string, Record<string, unknown>]>([
    ["an api-key credential", { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" }],
    [
      "an api-key credential with an external secret reference",
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key", secretRef: SECRET_REF },
    ],
    [
      "a guided custom OAuth credential",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        vendor: "CustomOauth2",
        clientId: "client-1",
        discoveryUrl: DISCOVERY_URL,
        scopes: ["openid"],
        managed: true,
      },
    ],
    [
      "a custom OAuth credential with a complete provider config",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        vendor: "CustomOauth2",
        providerConfig: {
          customOauth2ProviderConfig: {
            clientId: "client-1",
            oauthDiscovery: { discoveryUrl: DISCOVERY_URL },
          },
        },
      },
    ],
    [
      "a vendored OAuth credential with an external client secret reference",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: { githubOauth2ProviderConfig: { clientId: "client-1" } },
        clientSecretRef: SECRET_REF,
      },
    ],
  ])("accepts %s and retains its fields", (_label, value) => {
    const result = CredentialSchema.safeParse(value);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject(value);
  });

  it("defaults the OAuth vendor to CustomOauth2", () => {
    const result = CredentialSchema.safeParse({
      authorizerType: "OAuthCredentialProvider",
      name: "idp",
      clientId: "client-1",
      discoveryUrl: DISCOVERY_URL,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ vendor: "CustomOauth2" });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      "a vendored OAuth credential without a provider config",
      { authorizerType: "OAuthCredentialProvider", name: "github", vendor: "GithubOauth2" },
      /providerConfig/,
    ],
    [
      "a guided custom OAuth credential without a discovery URL",
      { authorizerType: "OAuthCredentialProvider", name: "idp", clientId: "client-1" },
      /discoveryUrl/,
    ],
    [
      "a provider config combined with guided fields",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        discoveryUrl: DISCOVERY_URL,
        providerConfig: { customOauth2ProviderConfig: {} },
      },
      /mutually exclusive/,
    ],
    [
      "a provider config with a nested clientSecret",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: {
          githubOauth2ProviderConfig: { clientId: "client-1", clientSecret: "sssh" },
        },
      },
      /secret material.*clientSecret/,
    ],
    [
      "a provider config with a nested apiKey",
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: { githubOauth2ProviderConfig: { nested: { apiKey: "sssh" } } },
      },
      /secret material.*apiKey/,
    ],
    [
      "a secret reference with unexpected fields",
      {
        authorizerType: "ApiKeyCredentialProvider",
        name: "svc-key",
        secretRef: { ...SECRET_REF, extra: "bad" },
      },
      /secretRef/,
    ],
    [
      "an invalid credential name",
      { authorizerType: "ApiKeyCredentialProvider", name: "bad name!" },
      /alphanumeric/,
    ],
    [
      "a credential name shorter than 3 characters",
      { authorizerType: "ApiKeyCredentialProvider", name: "ab" },
      /3 characters/,
    ],
  ])("rejects %s", (_label, value, message) => {
    const result = CredentialSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(message);
  });
});
