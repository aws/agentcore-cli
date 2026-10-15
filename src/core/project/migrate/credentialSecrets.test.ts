import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  backfillCredentialSecrets,
  gatewayCredentialNames,
  type CredentialSecretLookups,
} from "./credentialSecrets";
import { F1_DEPLOYED_STATE, F1_SPEC, writeV0Project } from "./migrate-test-support";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const ARN = "arn:aws:bedrock-agentcore:us-east-1:998846730471";
const KEY_SECRET = "arn:aws:secretsmanager:us-east-1:998846730471:secret:apikey/compatA-key-AbCdEf";
const OAUTH_SECRET =
  "arn:aws:secretsmanager:us-east-1:998846730471:secret:oauth2/compatA-oauth-GhIjKl";
const OPTIONS = { region: "us-east-1" };
const DENIED = "User is not authorized to perform this action";

/** Identity reads answered from a map of provider name to secret ARN (or the error to throw). */
function fakeIdentity(secrets: Record<string, string | Error | undefined>) {
  const calls: string[] = [];
  const answer = (kind: string, name: string) => {
    calls.push(`${kind}:${name}`);
    const secret = secrets[name];
    if (secret instanceof Error) throw secret;
    return secret;
  };
  const identity: CredentialSecretLookups = {
    getApiKeyCredentialProvider: async (name) => {
      const secretArn = answer("apiKey", name);
      return { ...(secretArn && { apiKeySecretArn: { secretArn } }) } as never;
    },
    getOauth2CredentialProvider: async (name) => {
      const secretArn = answer("oauth2", name);
      return { ...(secretArn && { clientSecretArn: { secretArn } }) } as never;
    },
  };
  return Object.assign(identity, { calls });
}

async function project(deployedState: unknown = F1_DEPLOYED_STATE): Promise<string> {
  const { root, cleanup } = await writeV0Project({ deployedState });
  cleanups.push(cleanup);
  return root;
}

function backfill(
  root: string,
  identity: CredentialSecretLookups,
  gatewayCredentials: string[] = [],
  credentials: { name: string; authorizerType: string }[] = F1_SPEC.credentials,
) {
  return backfillCredentialSecrets({
    identity,
    rootPath: root,
    credentials,
    gatewayCredentials: new Set(gatewayCredentials),
    target: "default",
    options: OPTIONS,
  });
}

const recorded = (deployedState: string | undefined) =>
  JSON.parse(deployedState!).targets.default.resources.credentials;

const notFound = () => new ResourceNotFoundException({ message: "not found", $metadata: {} });

describe("backfillCredentialSecrets", () => {
  test("fills in the API key and OAuth secret ARNs v0 didn't record", async () => {
    const root = await project();
    const identity = fakeIdentity({ "compatA-key": KEY_SECRET, "compatA-oauth": OAUTH_SECRET });

    const result = await backfill(root, identity);

    expect(identity.calls).toEqual(["apiKey:compatA-key", "oauth2:compatA-oauth"]);
    expect(recorded(result.deployedState)).toEqual({
      "compatA-key": {
        credentialProviderArn: `${ARN}:token-vault/default/apikeycredentialprovider/compatA-key`,
        clientSecretArn: KEY_SECRET,
      },
      "compatA-oauth": {
        credentialProviderArn: `${ARN}:token-vault/default/oauth2credentialprovider/compatA-oauth`,
        clientSecretArn: OAUTH_SECRET,
      },
    });
    // Everything else in the file is kept as it was.
    expect(JSON.parse(result.deployedState!).targets.default.resources.memories).toEqual(
      F1_DEPLOYED_STATE.targets.default.resources.memories,
    );
    expect(result.check).toEqual({
      name: "credential secrets",
      ok: true,
      message:
        "found the secret ARNs v0 didn't record for compatA-key, compatA-oauth; migrating " +
        "records them in agentcore/.cli/deployed-state.json",
    });
    expect(result.warnings).toEqual([]);
    // The project itself isn't written.
    expect(
      JSON.parse(await readFile(join(root, "agentcore", ".cli", "deployed-state.json"), "utf8")),
    ).toEqual(F1_DEPLOYED_STATE);
  });

  test("makes no lookups when every secret ARN is recorded, and skips payment providers", async () => {
    const credentials = {
      "compatA-key": {
        credentialProviderArn: `${ARN}:token-vault/default/apikeycredentialprovider/compatA-key`,
        clientSecretArn: KEY_SECRET,
      },
      "compatA-pay": {
        credentialProviderArn: `${ARN}:token-vault/default/paymentcredentialprovider/compatA-pay`,
      },
    };
    const root = await project({
      targets: {
        default: { resources: { ...F1_DEPLOYED_STATE.targets.default.resources, credentials } },
      },
    });
    const identity = fakeIdentity({});

    const result = await backfill(
      root,
      identity,
      [],
      [
        { name: "compatA-key", authorizerType: "ApiKeyCredentialProvider" },
        { name: "compatA-pay", authorizerType: "PaymentCredentialProvider" },
      ],
    );

    expect(identity.calls).toEqual([]);
    expect(result).toEqual({ warnings: [] });
  });

  test("fails the check for a Gateway's credential whose secret ARN can't be read", async () => {
    const root = await project();
    const identity = fakeIdentity({
      "compatA-key": new Error(DENIED),
      "compatA-oauth": OAUTH_SECRET,
    });

    const result = await backfill(root, identity, ["compatA-key"]);

    expect(result.check?.ok).toBe(false);
    expect(result.check?.message).toContain(
      `compatA-key: GetApiKeyCredentialProvider failed (${DENIED}); check that these ` +
        "credentials can call bedrock-agentcore:GetApiKeyCredentialProvider in us-east-1",
    );
    // Only the API actually called is named.
    expect(result.check?.message).not.toContain("GetOauth2CredentialProvider");
    expect(result.check?.message).toContain("run `agentcore migrate` again");
    expect(result.check?.message).toContain("The secret ARNs of compatA-oauth were found.");
    expect(result.warnings).toEqual([]);
    expect(recorded(result.deployedState)["compatA-key"].clientSecretArn).toBeUndefined();
    expect(recorded(result.deployedState)["compatA-oauth"].clientSecretArn).toBe(OAUTH_SECRET);
  });

  test("only warns for credentials no Gateway target uses, with advice for each cause", async () => {
    const root = await project();
    const identity = fakeIdentity({ "compatA-key": notFound() });

    const result = await backfill(root, identity);

    expect(result.check).toBeUndefined();
    expect(result.deployedState).toBeUndefined();
    expect(result.warnings).toEqual([
      "v0 didn't record the secret ARN of credential compatA-key, and it couldn't be found: its " +
        "provider 'compatA-key' no longer exists in AgentCore Identity; recreate it, or remove " +
        "the credential from the project. No Gateway target uses it, so migrating doesn't need it.",
      "v0 didn't record the secret ARN of credential compatA-oauth, and it couldn't be found: its " +
        "provider 'compatA-oauth' has no stored secret. No Gateway target uses it, so migrating " +
        "doesn't need it.",
    ]);
  });

  test("names the OAuth API when an OAuth provider's lookup fails", async () => {
    const root = await project();
    const identity = fakeIdentity({
      "compatA-key": KEY_SECRET,
      "compatA-oauth": new Error(DENIED),
    });

    const result = await backfill(root, identity, ["compatA-oauth"]);

    expect(result.check?.ok).toBe(false);
    expect(result.check?.message).toContain(
      `compatA-oauth: GetOauth2CredentialProvider failed (${DENIED})`,
    );
    expect(result.check?.message).not.toContain("GetApiKeyCredentialProvider");
  });
});

describe("gatewayCredentialNames", () => {
  test("names the credentials Gateway targets authenticate with by API key or OAuth", () => {
    const spec = {
      agentCoreGateways: [
        {
          targets: [
            { outboundAuth: { type: "API_KEY", credentialName: "orders" } },
            { outboundAuth: { type: "OAUTH", credentialName: "crm" } },
            { outboundAuth: { type: "NONE" } },
            { outboundAuth: { type: "GATEWAY_IAM_ROLE", credentialName: "ignored" } },
            {},
          ],
        },
        {},
      ],
    };

    expect([...gatewayCredentialNames(spec)]).toEqual(["orders", "crm"]);
    expect(gatewayCredentialNames({}).size).toBe(0);
  });
});
