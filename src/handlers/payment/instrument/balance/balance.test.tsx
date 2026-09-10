import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  ResourceNotFoundException,
  ValidationException,
  type BedrockAgentCoreClient,
  type GetPaymentInstrumentBalanceResponse,
  type GetPaymentInstrumentResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  GetPaymentManagerCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient, type ClientConfig } from "../../../../core";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  fixtureFactories,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";

const FIXTURES = join(import.meta.dir, "..", "..", "__fixtures__", "instrument");
const REGION = "us-west-2";
const MANAGER_ID = "balance-manager";
const MANAGER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:payment-manager/balance-manager";
const USER_ID = "balance-user";
const CONNECTOR_ID = "balance-connector";
const INSTRUMENT_ID = "balance-instrument";

// Synthetic SDK response, not evidence of a live funded-wallet query.
const BALANCE_RESPONSE = {
  paymentInstrumentId: INSTRUMENT_ID,
  tokenBalance: {
    amount: "9007199254740993123456789",
    decimals: 6,
    token: "USDC",
    network: "ETHEREUM",
    chain: "BASE",
  },
} satisfies GetPaymentInstrumentBalanceResponse;

const requiredFlags = [
  ["--manager-id", MANAGER_ID],
  ["--user-id", USER_ID],
  ["--connector-id", CONNECTOR_ID],
  ["--instrument-id", INSTRUMENT_ID],
  ["--chain", "BASE"],
] as const;

function createCommandTest({
  response = BALANCE_RESPONSE,
  error,
}: {
  response?: GetPaymentInstrumentBalanceResponse | GetPaymentInstrumentResponse;
  error?: Error;
} = {}) {
  const sent: { input: unknown }[] = [];
  const configs: ClientConfig[] = [];
  const lookups: GetPaymentManagerCommand[] = [];
  const controlConfigs: ClientConfig[] = [];
  const { createIamClient, createLogsClient } = fixtureFactories(FIXTURES);
  const core = new CoreClient({
    createControlClient: (config) => {
      controlConfigs.push(config);
      return {
        send: async (command: GetPaymentManagerCommand) => {
          expect(command).toBeInstanceOf(GetPaymentManagerCommand);
          lookups.push(command);
          return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
        },
      } as unknown as BedrockAgentCoreControlClient;
    },
    createDataClient: (config) => {
      configs.push(config);
      return {
        send: async (command: { input: unknown }) => {
          sent.push(command);
          if (error) throw error;
          return response;
        },
      } as unknown as BedrockAgentCoreClient;
    },
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    io,
    sent,
    configs,
    lookups,
    controlConfigs,
    run: (args: string[], region = REGION) =>
      root.route([
        "node",
        "agentcore",
        "payment",
        "instrument",
        ...args,
        "--region",
        region,
        "--json",
      ]),
  };
}

describe("payment instrument balance", () => {
  test("sends the balance command with exact scope and a default USDC token", async () => {
    const { run, io, sent, lookups } = createCommandTest();
    await run(["balance", ...requiredFlags.flat()]);

    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.input).toStrictEqual({ paymentManagerId: MANAGER_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
    expect(sent[0]?.input).toStrictEqual({
      paymentManagerArn: MANAGER_ARN,
      userId: USER_ID,
      paymentConnectorId: CONNECTOR_ID,
      paymentInstrumentId: INSTRUMENT_ID,
      chain: "BASE",
      token: "USDC",
    });
    expect(JSON.parse(io.stdout())).toEqual(BALANCE_RESPONSE);
  });

  test("forwards an explicit token and optional agent name", async () => {
    const { run, sent } = createCommandTest();
    await run([
      "balance",
      ...requiredFlags.flat(),
      "--token",
      "USDC",
      "--agent-name",
      "balance-agent",
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
    expect(sent[0]?.input).toStrictEqual({
      paymentManagerArn: MANAGER_ARN,
      userId: USER_ID,
      paymentConnectorId: CONNECTOR_ID,
      paymentInstrumentId: INSTRUMENT_ID,
      chain: "BASE",
      token: "USDC",
      agentName: "balance-agent",
    });
  });

  test.each(["BASE", "BASE_SEPOLIA", "ETHEREUM", "SOLANA", "SOLANA_DEVNET"])(
    "forwards the %s chain unchanged",
    async (chain) => {
      const { run, sent } = createCommandTest();
      await run([
        "balance",
        ...requiredFlags.filter(([name]) => name !== "--chain").flat(),
        "--chain",
        chain,
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
      expect(sent[0]?.input).toStrictEqual({
        paymentManagerArn: MANAGER_ARN,
        userId: USER_ID,
        paymentConnectorId: CONNECTOR_ID,
        paymentInstrumentId: INSTRUMENT_ID,
        chain,
        token: "USDC",
      });
    },
  );

  test("preserves atomic amounts beyond MAX_SAFE_INTEGER and token decimals in JSON", async () => {
    const { run, io } = createCommandTest();
    await run(["balance", ...requiredFlags.flat()]);

    expect(JSON.parse(io.stdout())).toEqual({
      paymentInstrumentId: INSTRUMENT_ID,
      tokenBalance: {
        amount: "9007199254740993123456789",
        decimals: 6,
        token: "USDC",
        network: "ETHEREUM",
        chain: "BASE",
      },
    });
  });

  test("preserves a successful zero balance as the raw string", async () => {
    const response: GetPaymentInstrumentBalanceResponse = {
      ...BALANCE_RESPONSE,
      tokenBalance: { ...BALANCE_RESPONSE.tokenBalance, amount: "0" },
    };
    const { run, io } = createCommandTest({ response });
    await run(["balance", ...requiredFlags.flat()]);

    expect(JSON.parse(io.stdout())).toEqual(response);
    expect(JSON.parse(io.stdout()).tokenBalance.amount).toBe("0");
  });

  test("forwards context region and endpoint to both SDK factories without deriving the ARN region", async () => {
    const { run, configs, controlConfigs, sent } = createCommandTest();
    await run(
      ["balance", ...requiredFlags.flat(), "--endpoint-url", "https://payments.example.test"],
      "eu-west-1",
    );

    expect(configs).toEqual([{ region: "eu-west-1", endpoint: "https://payments.example.test" }]);
    expect(controlConfigs).toEqual([
      { region: "eu-west-1", endpoint: "https://payments.example.test" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
  });
});

describe("payment instrument balance validation", () => {
  test("rejects the removed --manager-arn flag, including alongside --manager-id", async () => {
    const { run, io, sent, lookups } = createCommandTest();
    for (const idArgs of [[], requiredFlags.flat()]) {
      await expect(run(["balance", ...idArgs, "--manager-arn", MANAGER_ARN])).rejects.toThrow(
        /unknown option '--manager-arn'/,
      );
    }
    expect(sent).toEqual([]);
    expect(lookups).toEqual([]);
    expect(io.stdout()).toBe("");
  });

  test.each(["manager-id", "user-id", "connector-id", "instrument-id", "chain"])(
    "requires --%s before calling the SDK",
    async (name) => {
      const { run, io, sent, configs, lookups } = createCommandTest();
      await expect(
        run(["balance", ...requiredFlags.filter(([flag]) => flag !== `--${name}`).flat()]),
      ).rejects.toThrow(`required option '--${name} <${name}>' not specified`);

      expect(sent).toEqual([]);
      expect(configs).toEqual([]);
      expect(lookups).toEqual([]);
      expect(io.stdout()).toBe("");
    },
  );

  test.each(["manager-id", "user-id", "connector-id", "instrument-id"])(
    "rejects an explicitly empty --%s before calling the SDK",
    async (name) => {
      const { run, io, sent, configs, lookups } = createCommandTest();
      await expect(
        run([
          "balance",
          ...requiredFlags.map(([flag, value]) => [flag, flag === `--${name}` ? "" : value]).flat(),
        ]),
      ).rejects.toThrow(`required option '--${name} <${name}>' not specified`);

      expect(sent).toEqual([]);
      expect(configs).toEqual([]);
      expect(lookups).toEqual([]);
      expect(io.stdout()).toBe("");
    },
  );

  test.each(["BITCOIN", "base", "1", ""])("rejects invalid chain %j", async (chain) => {
    const { run, io, sent, configs } = createCommandTest();
    await expect(
      run([
        "balance",
        ...requiredFlags.filter(([name]) => name !== "--chain").flat(),
        "--chain",
        chain,
      ]),
    ).rejects.toThrow(/Invalid value for option '--chain'/);

    expect(sent).toEqual([]);
    expect(configs).toEqual([]);
    expect(io.stdout()).toBe("");
  });

  test.each(["ETH", "usdc", ""])("rejects invalid token %j", async (token) => {
    const { run, io, sent, configs } = createCommandTest();
    await expect(run(["balance", ...requiredFlags.flat(), "--token", token])).rejects.toThrow(
      /Invalid value for option '--token'/,
    );

    expect(sent).toEqual([]);
    expect(configs).toEqual([]);
    expect(io.stdout()).toBe("");
  });

  test.each([
    new ValidationException({
      message: "No USDC balance is available for this instrument on BASE",
      reason: "FieldValidationFailed",
      $metadata: {},
    }),
    new ResourceNotFoundException({
      message: "Payment instrument not found",
      $metadata: {},
    }),
  ])("surfaces $name without rendering a zero balance", async (error) => {
    const { run, io, sent } = createCommandTest({ error });
    await expect(run(["balance", ...requiredFlags.flat()])).rejects.toBe(error);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
    expect(io.stdout()).toBe("");
  });
});

describe("payment instrument get remains separate from balance", () => {
  test("gets metadata without requiring a chain or querying balance", async () => {
    const response: GetPaymentInstrumentResponse = {
      paymentInstrument: {
        paymentInstrumentId: INSTRUMENT_ID,
        paymentManagerArn: MANAGER_ARN,
        paymentConnectorId: CONNECTOR_ID,
        userId: USER_ID,
        paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
        paymentInstrumentDetails: {
          embeddedCryptoWallet: {
            network: "ETHEREUM",
            linkedAccounts: [{ email: { emailAddress: "balance@example.test" } }],
            walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
          },
        },
        status: "ACTIVE",
        createdAt: new Date("2026-09-09T00:00:00Z"),
        updatedAt: new Date("2026-09-09T00:00:00Z"),
      },
    };
    const { run, io, sent } = createCommandTest({ response });
    await run([
      "get",
      "--manager-id",
      MANAGER_ID,
      "--user-id",
      USER_ID,
      "--instrument-id",
      INSTRUMENT_ID,
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetPaymentInstrumentCommand);
    expect(sent[0]?.input).toStrictEqual({
      paymentManagerArn: MANAGER_ARN,
      userId: USER_ID,
      paymentInstrumentId: INSTRUMENT_ID,
    });
    const output = JSON.parse(io.stdout());
    expect(output.paymentInstrument.paymentInstrumentId).toBe(INSTRUMENT_ID);
    expect(output.paymentInstrument.status).toBe("ACTIVE");
    expect(output).not.toHaveProperty("tokenBalance");
  });
});
