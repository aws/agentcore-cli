import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type {
  CreatePaymentInstrumentRequest,
  EmbeddedCryptoWallet,
} from "@aws-sdk/client-bedrock-agentcore";
import { CoreClient } from "../../../core";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  parse,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import instrumentCreateFixture from "../__fixtures__/instrument/CreatePaymentInstrumentCommand.7b6d22c9eab936d3.json";

const PAYMENT_FIXTURES = join(import.meta.dir, "..", "__fixtures__");
const FIXTURES = join(PAYMENT_FIXTURES, "instrument");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const CONNECTOR_ID = "mycdpconnectoraidandal-okve8guw4y";
const USER_ID = "agentcore-cli-e2e";
const EMAIL = "agentcore-cli-e2e@example.com";
const scoped = ["--manager-id", MANAGER_ID, "--user-id", USER_ID];
const connectorScoped = [...scoped, "--connector-id", CONNECTOR_ID];
const shorthand = ["--network", "ETHEREUM", "--email", EMAIL];

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  return new CoreClient({
    ...fixtureFactories(PAYMENT_FIXTURES),
    createDataClient: fixtureFactories(fixtures).createDataClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[], core = createFixtureCore(), io = testIO()): Promise<string> {
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "payment", "instrument", ...args, "--region", REGION]);
  return io.stdout();
}

async function capture(args: string[], stdin?: string): Promise<CreatePaymentInstrumentRequest> {
  const data = fixtureFactories(FIXTURES).createDataClient({ region: REGION });
  const send = spyOn(data, "send").mockResolvedValue(
    parse(JSON.stringify(instrumentCreateFixture)),
  );
  const core = new CoreClient({
    ...fixtureFactories(PAYMENT_FIXTURES),
    createDataClient: () => data,
    logger: createSilentLogger(),
  });
  await run(["create", ...connectorScoped, ...args], core, testIO({ stdin }));
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0].input as CreatePaymentInstrumentRequest;
}

describe("payment instrument wallet inputs", () => {
  test.each([
    { flags: ["--network", "ETHEREUM"], conflict: "network" },
    { flags: ["--email", EMAIL], conflict: "email" },
    { flags: ["--phone-number", "+15555550100"], conflict: "phone-number" },
  ])(
    "rejects shorthand $flags alongside JSON before reading stdin",
    async ({ flags, conflict }) => {
      const core = createFixtureCore();
      const create = spyOn(core.payment, "createPaymentInstrument");
      const io = testIO({ stdin: "{}" });
      await expect(
        run(["create", ...connectorScoped, ...flags, "--instrument-details", "-"], core, io),
      ).rejects.toThrow(`--instrument-details, --${conflict} are mutually exclusive`);
      expect(create).not.toHaveBeenCalled();
      expect(io.io.stdin.readableLength).toBe(2);
    },
  );

  test("shorthand needs a network and at least one linked account", async () => {
    await expect(run(["create", ...connectorScoped, "--email", EMAIL])).rejects.toThrow(
      "required option '--network <network>' not specified",
    );
    await expect(run(["create", ...connectorScoped, "--network", "ETHEREUM"])).rejects.toThrow(
      "at least one --email or --phone-number",
    );
  });

  test("shorthand preserves repeated email/SMS accounts and omits unset metadata", async () => {
    const request = await capture([
      "--network",
      "SOLANA",
      "--email",
      "one@example.com",
      "--email",
      "two@example.com",
      "--phone-number",
      "+15555550100",
    ]);
    expect(request.paymentInstrumentType).toBe("EMBEDDED_CRYPTO_WALLET");
    expect(request.paymentInstrumentDetails).toEqual({
      embeddedCryptoWallet: {
        network: "SOLANA",
        linkedAccounts: [
          { email: { emailAddress: "one@example.com" } },
          { email: { emailAddress: "two@example.com" } },
          { sms: { phoneNumber: "+15555550100" } },
        ],
      },
    });
    expect(request).not.toHaveProperty("agentName");
    expect(request).not.toHaveProperty("clientToken");
  });

  test.each(["inline", "stdin"])(
    "passes the full wallet and optional metadata from %s",
    async (source) => {
      const wallet: EmbeddedCryptoWallet = {
        network: "ETHEREUM",
        linkedAccounts: [
          { developerJwt: { kid: "key-1", sub: "user-1" } },
          { oAuth2: { google: { sub: "google-sub", emailAddress: "g@example.com" } } },
        ],
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        redirectUrl: "https://example.test/return",
      };
      const json = JSON.stringify(wallet);
      const request = await capture(
        [
          "--instrument-details",
          source === "stdin" ? "-" : json,
          "--agent-name",
          "my-agent",
          "--client-token",
          "token-1",
        ],
        source === "stdin" ? json : undefined,
      );
      expect(request.paymentInstrumentDetails).toEqual({ embeddedCryptoWallet: wallet });
      expect(request.paymentInstrumentType).toBe("EMBEDDED_CRYPTO_WALLET");
      expect(request.agentName).toBe("my-agent");
      expect(request.clientToken).toBe("token-1");
    },
  );
});

test("payment instrument lifecycle replays wallet provisioning and deletion through root/Core", async () => {
  const created = await run(["create", ...connectorScoped, ...shorthand]);
  matchGolden(FIXTURES, "instrument-create.golden.json", created);
  const { paymentInstrument } = JSON.parse(created);
  const instrumentArgs = ["--instrument-id", paymentInstrument.paymentInstrumentId];

  const detail = await run(["get", ...scoped, ...instrumentArgs]);
  matchGolden(FIXTURES, "instrument-get.golden.json", detail);
  const wallet = JSON.parse(detail).paymentInstrument;
  expect(wallet.paymentInstrumentId).toBe(paymentInstrument.paymentInstrumentId);
  expect(wallet.paymentConnectorId).toBe(CONNECTOR_ID);
  expect(wallet.status).toBe("ACTIVE");
  expect(wallet.paymentInstrumentDetails.embeddedCryptoWallet.walletAddress).toMatch(
    /^0x[0-9a-fA-F]{40}$/,
  );

  const deleted = await run(["delete", ...connectorScoped, ...instrumentArgs]);
  matchGolden(FIXTURES, "instrument-delete.golden.json", deleted);
  expect(JSON.parse(deleted).status).toBe("DELETED");

  // The same Get request has a separate post-delete fixture.
  await expect(
    run(["get", ...scoped, ...instrumentArgs], createFixtureCore(join(FIXTURES, "after-delete"))),
  ).rejects.toThrow(/ResourceNotFound|not found/i);
});
