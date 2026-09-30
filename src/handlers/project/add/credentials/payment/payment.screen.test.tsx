import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForFlatText,
  waitForText,
} from "../../../../../testing";
import { InputValidationError } from "../../../../../errors";
import type { AppIO } from "../../../../../io";
import { createRootHandler } from "../../../../index";
import { createPaymentProjectTestHarness } from "../../payment-test-support";

const { cleanup, inProject, projectSpec, run } = createPaymentProjectTestHarness(
  "add-payment-credential-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

function coinbaseApiKeySecret(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from(key.d!, "base64url"),
    Buffer.from(key.x!, "base64url"),
  ]).toString("base64");
}

function p256PrivateKey(): string {
  return generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
}

async function nameCredential(screen: ReturnType<typeof renderScreen>, name = "payments") {
  await waitForText(screen.lastFrame, "what should this credential provider be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "which payment provider?");
}

describe("project add credentials payment wizard", () => {
  test("adds CoinbaseCDP credentials from two secret files", async () => {
    const projectRoot = await inProject();
    const apiKeySecretPath = join(projectRoot, "coinbase-api-key.txt");
    const walletSecretPath = join(projectRoot, "coinbase-wallet-key.txt");
    const apiKeySecret = coinbaseApiKeySecret();
    const walletSecret = p256PrivateKey();
    await writeFile(apiKeySecretPath, `${apiKeySecret}\n`);
    await writeFile(walletSecretPath, `${walletSecret}\n`);
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen, "coinbase-prod");
    expect(screen.lastFrame()).toContain("❯ ● CoinbaseCDP");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what are the CoinbaseCDP credentials?");
    await screen.write("coinbase-key");
    await screen.press("return");
    await screen.write(apiKeySecretPath);
    expect(screen.lastFrame()).not.toContain(apiKeySecret);
    await screen.press("return");
    await screen.write(walletSecretPath);
    expect(screen.lastFrame()).not.toContain(walletSecret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("credential coinbase-prod");
    expect(review).toContain("provider CoinbaseCDP");
    expect(review).toContain("API key ID coinbase-key");
    expect(review.replaceAll(" ", "")).toContain(apiKeySecretPath);
    expect(review.replaceAll(" ", "")).toContain(walletSecretPath);
    expect(review).not.toContain(apiKeySecret);
    expect(review).not.toContain(walletSecret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'coinbase-prod' to 'TestProject'");
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: "coinbase-prod",
        provider: "CoinbaseCDP",
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_COINBASE_PROD_API_KEY_ID='coinbase-key'");
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PROD_API_KEY_SECRET='${apiKeySecret}'`);
    expect(env).toContain(`AGENTCORE_CREDENTIAL_COINBASE_PROD_WALLET_SECRET='${walletSecret}'`);
    expect(screen.frames.join("\n")).not.toContain(apiKeySecret);
    expect(screen.frames.join("\n")).not.toContain(walletSecret);
    screen.unmount();
  }, 15000);

  test("adds StripePrivy credentials and normalizes the authorization key", async () => {
    const projectRoot = await inProject();
    const appSecretPath = join(projectRoot, "privy-app-secret.txt");
    const authorizationKeyPath = join(projectRoot, "stripe-authorization-key.txt");
    const appSecret = "cHJpdnktYXBwLXNlY3JldA==";
    const authorizationKey = p256PrivateKey();
    await writeFile(appSecretPath, `${appSecret}\n`);
    await writeFile(authorizationKeyPath, `wallet-auth:${authorizationKey}\n`);
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen, "stripe-prod");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● StripePrivy");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what are the StripePrivy credentials?");
    await screen.write("privy-app");
    await screen.press("return");
    await screen.write(appSecretPath);
    await screen.press("return");
    await screen.write(authorizationKeyPath);
    await screen.press("return");
    await screen.write("stripe-authorization");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("provider StripePrivy");
    expect(review).toContain("app ID privy-app");
    expect(review.replaceAll(" ", "")).toContain(appSecretPath);
    expect(review.replaceAll(" ", "")).toContain(authorizationKeyPath);
    expect(review).toContain("authorization ID stripe-authorization");
    expect(review).not.toContain(appSecret);
    expect(review).not.toContain(authorizationKey);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'stripe-prod'");
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: "stripe-prod",
        provider: "StripePrivy",
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_STRIPE_PROD_APP_ID='privy-app'");
    expect(env).toContain(`AGENTCORE_CREDENTIAL_STRIPE_PROD_APP_SECRET='${appSecret}'`);
    expect(env).toContain(
      `AGENTCORE_CREDENTIAL_STRIPE_PROD_AUTHORIZATION_PRIVATE_KEY='${authorizationKey}'`,
    );
    expect(env).toContain(
      "AGENTCORE_CREDENTIAL_STRIPE_PROD_AUTHORIZATION_ID='stripe-authorization'",
    );
    expect(env).not.toContain("wallet-auth:");
    expect(screen.frames.join("\n")).not.toContain(appSecret);
    expect(screen.frames.join("\n")).not.toContain(authorizationKey);
    screen.unmount();
  }, 15000);

  test("allows fields to be omitted and reports the resulting placeholders", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "what are the CoinbaseCDP credentials?");
    await screen.press("return");
    await screen.press("return");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("API key ID (not provided)");
    expect(review).toContain("API key secret file (not provided)");
    expect(review).toContain("wallet secret file (not provided)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'payments'");
    expect(screen.lastFrame()).toContain(
      "Set AGENTCORE_CREDENTIAL_PAYMENTS_API_KEY_ID in agentcore/.env.local",
    );
    expect(screen.lastFrame()).toContain(
      "Set AGENTCORE_CREDENTIAL_PAYMENTS_API_KEY_SECRET in agentcore/.env.local",
    );
    expect(screen.lastFrame()).toContain(
      "Set AGENTCORE_CREDENTIAL_PAYMENTS_WALLET_SECRET in agentcore/.env.local",
    );
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_PAYMENTS_API_KEY_ID=\n");
    expect(env).toContain("AGENTCORE_CREDENTIAL_PAYMENTS_API_KEY_SECRET=\n");
    expect(env).toContain("AGENTCORE_CREDENTIAL_PAYMENTS_WALLET_SECRET=\n");
    screen.unmount();
  }, 15000);

  test("requires every supplied secret path to identify a readable file", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "what are the CoinbaseCDP credentials?");
    await screen.press("return");
    await screen.write(join(projectRoot, "missing-api-key.txt"));
    await screen.press("return");

    await waitForText(screen.lastFrame, "no readable file at");
    expect(screen.lastFrame()).toContain("what are the CoinbaseCDP credentials?");
    expect(screen.lastFrame()).not.toContain("this credential will be added");
    screen.unmount();
  });

  test("validates identifiers before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen);
    await screen.press("return");
    await screen.write("invalid key");
    await screen.press("return");

    await waitForText(screen.lastFrame, "apiKeyId must contain only alphanumeric characters");
    expect(screen.lastFrame()).not.toContain("this credential will be added");
    screen.unmount();
  });

  test("validates secret file contents only during submission", async () => {
    const projectRoot = await inProject();
    const invalidSecretPath = join(projectRoot, "invalid-api-key.txt");
    const invalidSecret = "not-a-valid-key";
    await writeFile(invalidSecretPath, invalidSecret);
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen);
    await screen.press("return");
    await screen.press("return");
    await screen.write(invalidSecretPath);
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    expect(screen.lastFrame()).not.toContain(invalidSecret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "apiKeySecret must be a base64-encoded");
    expect(screen.lastFrame()).not.toContain(invalidSecret);
    expect((await projectSpec(projectRoot)).credentials ?? []).toEqual([]);
    screen.unmount();
  });

  test("validates the credential name live", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.write("bad name");

    await waitForText(screen.lastFrame, "Must contain only alphanumeric characters");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the review back", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "credentials",
      "payment",
      "--name",
      "duplicate-payment",
      "--provider",
      "CoinbaseCDP",
    ]);
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await nameCredential(screen, "duplicate-payment");
    await screen.press("return");
    await screen.press("return");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "same environment variable");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("credential duplicate-payment");
    expect((await projectSpec(projectRoot)).credentials).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("the StripePrivy credential page fits an 80x24 terminal", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");
    await screen.resize(80, 24);

    await nameCredential(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what are the StripePrivy credentials?");

    expect(screen.lastFrame()?.split("\n")).toHaveLength(24);
    expect(screen.lastFrame()).toContain("App ID");
    expect(screen.lastFrame()).toContain("Authorization ID");
    screen.unmount();
  });

  test("esc on the first step returns to the credentials menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/payment");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.press("escape");

    await waitForText(
      screen.lastFrame,
      "add AgentCore Identity credential providers to the current project",
    );
    screen.unmount();
  });
});

describe("project add credentials payment dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "credentials", "payment", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name");
  }

  test("a bare command in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "credentials", "payment"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("required option");
  }, 10000);

  test.each<[string, () => AppIO, string[]]>([
    ["a bare command without a TTY", () => testIO().io, []],
    ["a user-supplied flag in a TTY", () => ttyTestIO().streams.io, ["--provider", "CoinbaseCDP"]],
    ["--json in a TTY", () => ttyTestIO().streams.io, ["--json"]],
  ])("%s stays headless", async (_label, io, args) => {
    await inProject();

    expectMissingName(await routeError(io(), args));
  });

  test("flag-driven add still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "credentials",
      "payment",
      "--name",
      "flag-payment",
      "--provider",
      "CoinbaseCDP",
    ]);

    expect((await projectSpec(projectRoot)).credentials).toContainEqual({
      authorizerType: "PaymentCredentialProvider",
      name: "flag-payment",
      provider: "CoinbaseCDP",
    });
  }, 10000);
});
