import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BedrockAgentCoreClient,
  CreatePaymentInstrumentRequest,
  EmbeddedCryptoWallet,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  GetPaymentManagerCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

// End-to-end command-flow tests for the `payment instrument` leaves.
//
// Each test builds the real root handler over a real CoreClient whose SDK
// clients are the fixture-backed fakes, then drives it through `route()` exactly
// as the CLI does, so one test covers parsing, middleware, the leaf handler,
// PaymentClient, and the rendered output.
//
// Record with:
//   RECORD=1 AWS_PROFILE=deploy bun test src/handlers/payment/instrument/instrument.test.tsx
// The flow uses an AWS_IAM payment manager and a READY CoinbaseCDP connector that
// already exist in the test account (the manager quota is exhausted, so none is
// created here) and leaves nothing behind: it creates one embedded wallet and
// deletes it again.

const PAYMENT_FIXTURES = join(import.meta.dir, "..", "__fixtures__");
const FIXTURES = join(PAYMENT_FIXTURES, "instrument");
// Fixtures are keyed by operation and input, so a `get` issued after the delete
// would overwrite the pre-delete `get` fixture. Reads that expect the instrument
// to be gone record into their own directory.
const AFTER_DELETE_FIXTURES = join(FIXTURES, "after-delete");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const MANAGER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:603141041947:payment-manager/mypaymentmanageraidandal-gx3nxzaira";
const CONNECTOR_ID = "mycdpconnectoraidandal-okve8guw4y";
const USER_ID = "agentcore-cli-e2e";
const EMAIL = "agentcore-cli-e2e@example.com";
const FLOW_TIMEOUT = 120_000;

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  const { createControlClient, createIamClient, createLogsClient } =
    fixtureFactories(PAYMENT_FIXTURES);
  const { createDataClient } = fixtureFactories(fixtures);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

// createCapturingDataCore swaps the data plane's `.send()` for one that records
// the request it was handed, while keeping the real CoreClient and PaymentClient
// in the loop. Fixtures only key on the request hash, so this is how the tests
// assert the exact request each flag form builds.
function createCapturingDataCore(): {
  core: CoreClient;
  sent: unknown[];
  lookups: GetPaymentManagerCommand[];
} {
  const sent: unknown[] = [];
  const lookups: GetPaymentManagerCommand[] = [];
  const { createIamClient, createLogsClient } = fixtureFactories(PAYMENT_FIXTURES);
  const core = new CoreClient({
    createControlClient: () =>
      ({
        send: async (command: GetPaymentManagerCommand) => {
          expect(command).toBeInstanceOf(GetPaymentManagerCommand);
          lookups.push(command);
          return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
        },
      }) as unknown as BedrockAgentCoreControlClient,
    createDataClient: () =>
      ({
        send: async (command: { input: unknown }) => {
          sent.push(command.input);
          return {};
        },
      }) as unknown as BedrockAgentCoreClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
  return { core, sent, lookups };
}

function createRoot(core = createFixtureCore(), stdin?: string) {
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return { root, io };
}

async function run(
  args: string[],
  { fixtures = FIXTURES, stdin }: { fixtures?: string; stdin?: string } = {},
): Promise<string> {
  const { root, io } = createRoot(createFixtureCore(fixtures), stdin);
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

async function capture(args: string[], stdin?: string): Promise<CreatePaymentInstrumentRequest> {
  const { core, sent, lookups } = createCapturingDataCore();
  const { root } = createRoot(core, stdin);
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  expect(lookups).toHaveLength(1);
  expect(lookups[0]?.input).toEqual({ paymentManagerId: MANAGER_ID });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveProperty("paymentManagerArn", MANAGER_ARN);
  expect(sent[0]).not.toHaveProperty("managerId");
  return sent[0] as CreatePaymentInstrumentRequest;
}

const scoped = ["--manager-id", MANAGER_ID, "--user-id", USER_ID];
const connectorScoped = [...scoped, "--connector-id", CONNECTOR_ID];
const shorthand = ["--network", "ETHEREUM", "--email", EMAIL];
const walletJson = JSON.stringify({
  network: "ETHEREUM",
  linkedAccounts: [{ email: { emailAddress: EMAIL } }],
});

describe("payment instrument command hierarchy", () => {
  test("registers create, get, list, delete, and balance leaves", () => {
    const { root } = createRoot();
    const instrument = root
      .children()
      .find((child) => child.name() === "payment")
      ?.children()
      .find((child) => child.name() === "instrument");

    expect(instrument?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "delete",
      "balance",
    ]);
  });
});

describe("payment instrument validation", () => {
  test.each(["create", "get", "list", "delete"])(
    "`%s` rejects the removed --manager-arn flag, including alongside --manager-id",
    async (command) => {
      for (const idArgs of [[], scoped]) {
        await expect(
          run(["payment", "instrument", command, ...idArgs, "--manager-arn", MANAGER_ARN]),
        ).rejects.toThrow(/unknown option '--manager-arn'/);
      }
    },
  );

  test.each(["create", "get", "list", "delete"])(
    "`%s` rejects an explicitly empty --manager-id",
    async (command) => {
      await expect(
        run(["payment", "instrument", command, "--manager-id", "", "--user-id", USER_ID]),
      ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
    },
  );

  // Every leaf declares its identifying flags optional (so a bare invocation can
  // fall through to the TUI once one exists) but requires them at runtime. None
  // of these reach the SDK, so no fixtures are involved.
  test("`create` errors when --manager-id is omitted", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        "--user-id",
        USER_ID,
        "--connector-id",
        CONNECTOR_ID,
        ...shorthand,
      ]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`create` errors when --user-id is omitted", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        CONNECTOR_ID,
        ...shorthand,
      ]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });

  test("`create` errors when --connector-id is omitted", async () => {
    await expect(run(["payment", "instrument", "create", ...scoped, ...shorthand])).rejects.toThrow(
      /required option '--connector-id <connector-id>' not specified/,
    );
  });

  test("`create` rejects shorthand flags together with --instrument-details", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        ...connectorScoped,
        ...shorthand,
        "--instrument-details",
        walletJson,
      ]),
    ).rejects.toThrow(/--instrument-details is mutually exclusive with/);
  });

  test("`create` rejects --phone-number together with --instrument-details", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        ...connectorScoped,
        "--phone-number",
        "+15555550100",
        "--instrument-details",
        walletJson,
      ]),
    ).rejects.toThrow(/--instrument-details is mutually exclusive with/);
  });

  test("`create` errors when the shorthand form omits --network", async () => {
    await expect(
      run(["payment", "instrument", "create", ...connectorScoped, "--email", EMAIL]),
    ).rejects.toThrow(/required option '--network <network>' not specified/);
  });

  test("`create` errors when no wallet details are given at all", async () => {
    await expect(run(["payment", "instrument", "create", ...connectorScoped])).rejects.toThrow(
      /required option '--network <network>' not specified/,
    );
  });

  test("`create` errors when the shorthand form has no linked account", async () => {
    await expect(
      run(["payment", "instrument", "create", ...connectorScoped, "--network", "ETHEREUM"]),
    ).rejects.toThrow(/at least one --email or --phone-number/);
  });

  test("`create` rejects an unsupported --network", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        ...connectorScoped,
        "--network",
        "BITCOIN",
        "--email",
        EMAIL,
      ]),
    ).rejects.toThrow(/Invalid value for option '--network'/);
  });

  test("`create` rejects an unsupported --type", async () => {
    await expect(
      run(["payment", "instrument", "create", ...connectorScoped, ...shorthand, "--type", "CARD"]),
    ).rejects.toThrow(/Invalid value for option '--type'/);
  });

  test("`create` rejects malformed --instrument-details JSON", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "create",
        ...connectorScoped,
        "--instrument-details",
        "{not json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--instrument-details'/);
  });

  test("`create` rejects --instrument-details that is not a JSON object", async () => {
    await expect(
      run(["payment", "instrument", "create", ...connectorScoped, "--instrument-details", "[]"]),
    ).rejects.toThrow(/Option '--instrument-details' must be a JSON object/);
  });

  test("`get` errors when --instrument-id is omitted", async () => {
    await expect(run(["payment", "instrument", "get", ...scoped])).rejects.toThrow(
      /required option '--instrument-id <instrument-id>' not specified/,
    );
  });

  test("`get` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "instrument", "get", "--user-id", USER_ID, "--instrument-id", "i-1"]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`get` errors when --user-id is omitted", async () => {
    await expect(
      run(["payment", "instrument", "get", "--manager-id", MANAGER_ID, "--instrument-id", "i-1"]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });

  test("`list` errors when --manager-id is omitted", async () => {
    await expect(run(["payment", "instrument", "list", "--user-id", USER_ID])).rejects.toThrow(
      /required option '--manager-id <manager-id>' not specified/,
    );
  });

  test("`list` errors when --user-id is omitted", async () => {
    await expect(
      run(["payment", "instrument", "list", "--manager-id", MANAGER_ID]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });

  test("`delete` errors when --connector-id is omitted", async () => {
    await expect(
      run(["payment", "instrument", "delete", ...scoped, "--instrument-id", "i-1"]),
    ).rejects.toThrow(/required option '--connector-id <connector-id>' not specified/);
  });

  test("`delete` errors when --instrument-id is omitted", async () => {
    await expect(run(["payment", "instrument", "delete", ...connectorScoped])).rejects.toThrow(
      /required option '--instrument-id <instrument-id>' not specified/,
    );
  });

  test("`delete` errors when --manager-id is omitted", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "delete",
        "--user-id",
        USER_ID,
        "--connector-id",
        CONNECTOR_ID,
        "--instrument-id",
        "i-1",
      ]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`delete` errors when --user-id is omitted", async () => {
    await expect(
      run([
        "payment",
        "instrument",
        "delete",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        CONNECTOR_ID,
        "--instrument-id",
        "i-1",
      ]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });
});

describe("payment instrument create request mapping", () => {
  test("shorthand flags build one linked account per --email and --phone-number", async () => {
    const request = await capture([
      "payment",
      "instrument",
      "create",
      ...connectorScoped,
      "--network",
      "SOLANA",
      "--email",
      "one@example.com",
      "--email",
      "two@example.com",
      "--phone-number",
      "+15555550100",
    ]);

    expect(request).toEqual({
      paymentManagerArn: MANAGER_ARN,
      userId: USER_ID,
      paymentConnectorId: CONNECTOR_ID,
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: {
          network: "SOLANA",
          linkedAccounts: [
            { email: { emailAddress: "one@example.com" } },
            { email: { emailAddress: "two@example.com" } },
            { sms: { phoneNumber: "+15555550100" } },
          ],
        },
      },
    });
  });

  test("--instrument-details passes the wallet through, reaching every field", async () => {
    const wallet: EmbeddedCryptoWallet = {
      network: "ETHEREUM",
      linkedAccounts: [
        { developerJwt: { kid: "key-1", sub: "user-1" } },
        { oAuth2: { google: { sub: "google-sub", emailAddress: "g@example.com" } } },
      ],
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      redirectUrl: "https://example.test/return",
    };
    const request = await capture([
      "payment",
      "instrument",
      "create",
      ...connectorScoped,
      "--instrument-details",
      JSON.stringify(wallet),
    ]);

    expect(request.paymentInstrumentDetails).toEqual({ embeddedCryptoWallet: wallet });
    expect(request.paymentInstrumentType).toBe("EMBEDDED_CRYPTO_WALLET");
  });

  test("--instrument-details - reads the wallet from stdin", async () => {
    const request = await capture(
      ["payment", "instrument", "create", ...connectorScoped, "--instrument-details", "-"],
      walletJson,
    );

    expect(request.paymentInstrumentDetails).toEqual({
      embeddedCryptoWallet: JSON.parse(walletJson),
    });
  });

  test("optional --agent-name and --client-token are forwarded only when set", async () => {
    const bare = await capture([
      "payment",
      "instrument",
      "create",
      ...connectorScoped,
      ...shorthand,
    ]);
    expect(bare).not.toHaveProperty("agentName");
    expect(bare).not.toHaveProperty("clientToken");

    const full = await capture([
      "payment",
      "instrument",
      "create",
      ...connectorScoped,
      ...shorthand,
      "--agent-name",
      "my-agent",
      "--client-token",
      "token-1",
    ]);
    expect(full.agentName).toBe("my-agent");
    expect(full.clientToken).toBe("token-1");
  });
});

// ─── instrument flow (create → get → list → delete → get) ────────────────────
//
// Drives the lifecycle of a real embedded crypto wallet, in order, through
// route(). In record mode it hits the live data plane and persists every
// exchange; replays are offline and instant. Later tests consume the id parsed
// from earlier output.

const state: { instrumentId?: string } = {};

// pollUntilSettled re-runs `get` until the instrument is ACTIVE or the polling
// budget runs out, and returns the last observed status. The CoinbaseCDP
// connector has provisioned the wallet as ACTIVE within the create call itself;
// the poll guards a re-record against a slower INITIATED → ACTIVE transition.
// The fixture ends up holding the last poll; in replay the first read is final.
async function pollUntilSettled(command: string[]): Promise<string> {
  let status = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    status = JSON.parse(await run(command)).paymentInstrument.status;
    if (status === "ACTIVE" || !isRecording()) return status;
    await Bun.sleep(5_000);
  }
  return status;
}

describe("payment instrument flow", () => {
  test(
    "`create` provisions an embedded wallet from the shorthand flags",
    async () => {
      const out = await run(["payment", "instrument", "create", ...connectorScoped, ...shorthand]);
      matchGolden(FIXTURES, "instrument-create.golden.json", out);

      const { paymentInstrument } = JSON.parse(out);
      expect(paymentInstrument.paymentInstrumentId).toBeDefined();
      expect(paymentInstrument.paymentManagerArn).toBe(MANAGER_ARN);
      expect(paymentInstrument.paymentConnectorId).toBe(CONNECTOR_ID);
      expect(paymentInstrument.userId).toBe(USER_ID);
      expect(paymentInstrument.paymentInstrumentType).toBe("EMBEDDED_CRYPTO_WALLET");
      expect(paymentInstrument.paymentInstrumentDetails.embeddedCryptoWallet.network).toBe(
        "ETHEREUM",
      );
      state.instrumentId = paymentInstrument.paymentInstrumentId;

      const status = await pollUntilSettled([
        "payment",
        "instrument",
        "get",
        ...scoped,
        "--instrument-id",
        state.instrumentId!,
      ]);
      expect(status).toBe("ACTIVE");
    },
    FLOW_TIMEOUT,
  );

  test(
    "`get` returns the instrument",
    async () => {
      const out = await run([
        "payment",
        "instrument",
        "get",
        ...scoped,
        "--instrument-id",
        state.instrumentId!,
      ]);
      matchGolden(FIXTURES, "instrument-get.golden.json", out);

      const { paymentInstrument } = JSON.parse(out);
      expect(paymentInstrument.paymentInstrumentId).toBe(state.instrumentId);
      expect(paymentInstrument.paymentConnectorId).toBe(CONNECTOR_ID);
      expect(paymentInstrument.status).toBe("ACTIVE");
      expect(paymentInstrument.paymentInstrumentDetails.embeddedCryptoWallet.walletAddress).toMatch(
        /^0x[0-9a-fA-F]{40}$/,
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`list` includes the instrument",
    async () => {
      const out = await run(["payment", "instrument", "list", ...connectorScoped]);
      matchGolden(FIXTURES, "instrument-list.golden.json", out);

      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed.paymentInstruments)).toBe(true);
      expect(
        parsed.paymentInstruments.map(
          (instrument: { paymentInstrumentId: string }) => instrument.paymentInstrumentId,
        ),
      ).toContain(state.instrumentId);
    },
    FLOW_TIMEOUT,
  );

  test(
    "`delete` deletes the instrument",
    async () => {
      const out = await run([
        "payment",
        "instrument",
        "delete",
        ...connectorScoped,
        "--instrument-id",
        state.instrumentId!,
      ]);
      matchGolden(FIXTURES, "instrument-delete.golden.json", out);
      expect(JSON.parse(out).status).toBe("DELETED");
    },
    FLOW_TIMEOUT,
  );

  test(
    "`get` after delete reports the instrument gone",
    async () => {
      await expect(
        run(["payment", "instrument", "get", ...scoped, "--instrument-id", state.instrumentId!], {
          fixtures: AFTER_DELETE_FIXTURES,
        }),
      ).rejects.toThrow(/ResourceNotFound|not found/i);
    },
    FLOW_TIMEOUT,
  );
});
