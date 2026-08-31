import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createPaymentProjectTestHarness } from "../../payment-test-support";

const { cleanup, inProject, projectSpec, run } =
  createPaymentProjectTestHarness("payment-credential");

afterEach(cleanup);

function coinbaseApiKeySecret(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from(key.d!, "base64url"),
    Buffer.from(key.x!, "base64url"),
  ]).toString("base64");
}

describe("project add credentials payment", () => {
  test.each(["CoinbaseCDP", "StripePrivy"] as const)(
    "adds a reusable %s payment credential",
    async (provider) => {
      const projectRoot = await inProject();

      const io = await run([
        "add",
        "credentials",
        "payment",
        "--name",
        `${provider.toLowerCase()}-credential`,
        "--provider",
        provider,
      ]);

      expect((await projectSpec(projectRoot)).credentials).toEqual([
        {
          authorizerType: "PaymentCredentialProvider",
          name: `${provider.toLowerCase()}-credential`,
          provider,
        },
      ]);
      expect(io.stderr()).toContain(`added credential '${provider.toLowerCase()}-credential'`);
      const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
      const prefix = `AGENTCORE_CREDENTIAL_${provider.toUpperCase()}_CREDENTIAL`;
      const suffixes =
        provider === "CoinbaseCDP"
          ? ["API_KEY_ID", "API_KEY_SECRET", "WALLET_SECRET"]
          : ["APP_ID", "APP_SECRET", "AUTHORIZATION_PRIVATE_KEY", "AUTHORIZATION_ID"];
      for (const suffix of suffixes) {
        expect(env).toContain(`${prefix}_${suffix}=\n`);
        expect(io.stderr()).toContain(`Set ${prefix}_${suffix} in agentcore/.env.local`);
      }
    },
  );

  test("stores source-aware Coinbase credential values outside the project schema", async () => {
    const projectRoot = await inProject();
    const apiKeySecretPath = join(projectRoot, "api-key-secret.txt");
    const walletSecretPath = join(projectRoot, "wallet-secret.txt");
    const apiKeySecret = coinbaseApiKeySecret();
    const walletSecret = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    await Bun.write(apiKeySecretPath, `${apiKeySecret}\n`);
    await Bun.write(walletSecretPath, `${walletSecret}\n`);

    await run([
      "add",
      "credentials",
      "payment",
      "--name",
      "coinbase-prod",
      "--provider",
      "CoinbaseCDP",
      "--api-key-id",
      "api-key-id",
      "--api-key-secret",
      `file://${apiKeySecretPath}`,
      "--wallet-secret",
      `file://${walletSecretPath}`,
    ]);

    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: "coinbase-prod",
        provider: "CoinbaseCDP",
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_COINBASE_PROD_API_KEY_ID='api-key-id'");
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PROD_API_KEY_SECRET='${apiKeySecret}'`);
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PROD_WALLET_SECRET='${walletSecret}'`);
  });

  test("normalizes Coinbase key whitespace before persistence", async () => {
    const projectRoot = await inProject();
    const apiKeySecretPath = join(projectRoot, "api-key-secret-padded.txt");
    const walletSecretPath = join(projectRoot, "wallet-secret-padded.txt");
    const apiKeySecret = coinbaseApiKeySecret();
    const walletSecret = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    await Bun.write(apiKeySecretPath, `  ${apiKeySecret}  \n`);
    await Bun.write(walletSecretPath, `  ${walletSecret}  \n`);

    await run([
      "add",
      "credentials",
      "payment",
      "--name",
      "coinbase-padded",
      "--provider",
      "CoinbaseCDP",
      "--api-key-id",
      "coinbase_key",
      "--api-key-secret",
      `file://${apiKeySecretPath}`,
      "--wallet-secret",
      `file://${walletSecretPath}`,
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PADDED_API_KEY_SECRET='${apiKeySecret}'`);
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PADDED_WALLET_SECRET='${walletSecret}'`);
    expect(env).not.toContain(`'  ${apiKeySecret}  '`);
  });

  test("normalizes the documented Stripe authorization key prefix", async () => {
    const projectRoot = await inProject();
    const privateKeyPath = join(projectRoot, "private-key.txt");
    const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    await Bun.write(privateKeyPath, `wallet-auth:${privateKey}\n`);

    await run([
      "add",
      "credentials",
      "payment",
      "--name",
      "stripe-prod",
      "--provider",
      "StripePrivy",
      "--authorization-private-key",
      `file://${privateKeyPath}`,
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain(
      `AGENTCORE_CREDENTIAL_STRIPE_PROD_AUTHORIZATION_PRIVATE_KEY='${privateKey}'`,
    );
    expect(env).not.toContain("wallet-auth:");
  });

  test.each([
    [
      "inline Coinbase API key secret",
      ["--provider", "CoinbaseCDP", "--api-key-secret", "inline-secret"],
      "must come from stdin",
    ],
    [
      "Stripe option with Coinbase",
      ["--provider", "CoinbaseCDP", "--app-id", "privy-app"],
      "not valid with --provider CoinbaseCDP",
    ],
    [
      "Coinbase option with Stripe",
      ["--provider", "StripePrivy", "--api-key-id", "coinbase-key"],
      "not valid with --provider StripePrivy",
    ],
    [
      "invalid Coinbase API key ID",
      ["--provider", "CoinbaseCDP", "--api-key-id", "invalid key!"],
      "apiKeyId",
    ],
  ])("rejects %s without mutating the project", async (_label, flags, message) => {
    const projectRoot = await inProject();

    await expect(
      run(["add", "credentials", "payment", "--name", "payment-credential", ...flags]),
    ).rejects.toThrow(message);

    expect((await projectSpec(projectRoot)).credentials ?? []).toEqual([]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_PAYMENT_CREDENTIAL");
  });

  test.each([
    ["missing name", ["--provider", "CoinbaseCDP"], "required option '--name"],
    ["missing provider", ["--name", "payment-credential"], "required option '--provider"],
    [
      "unsupported provider",
      ["--name", "payment-credential", "--provider", "Unsupported"],
      "Invalid value for option '--provider'",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();

    await expect(run(["add", "credentials", "payment", ...flags])).rejects.toThrow(message);
    expect((await projectSpec(projectRoot)).credentials ?? []).toEqual([]);
  });

  test("rejects duplicate names across credential types", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "api-key", "--name", "shared"]);

    await expect(
      run(["add", "credentials", "payment", "--name", "shared", "--provider", "CoinbaseCDP"]),
    ).rejects.toThrow("already exists");

    expect((await projectSpec(projectRoot)).credentials).toHaveLength(1);
  });

  test("rejects a credential that would overlap a payment credential's variables", async () => {
    const projectRoot = await inProject();

    // The only way to collide with a payment credential 'stripe' is to be named for
    // one of its fields, so such a name is refused on its own — before a payment
    // credential exists to collide with, and whether or not one ever does.
    await expect(run(["add", "credentials", "api-key", "--name", "stripe_app_id"])).rejects.toThrow(
      /_APP_ID/,
    );

    expect((await projectSpec(projectRoot)).credentials ?? []).toHaveLength(0);
  });
});
