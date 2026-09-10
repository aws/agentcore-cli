import { describe, expect, mock, test } from "bun:test";
import {
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
  ListPaymentManagersCommand,
  type GetPaymentConnectorResponse,
  type GetPaymentManagerResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
  type GetPaymentInstrumentBalanceResponse,
  type PaymentInstrument,
  type PaymentSession,
} from "@aws-sdk/client-bedrock-agentcore";
import { ERROR_SOURCE, InputValidationError, MalformedServiceResponseError } from "../errors";
import type { CorePaymentClient } from "../handlers/payment/types";
import { PaymentClient } from "./payment";
import type { AwsClients, ClientConfig, CoreOptions } from "./types";

const MANAGER_ID = "checkout-abc1234567";
const MANAGER_ARN = `arn:aws:bedrock-agentcore:us-west-2:123456789012:payment-manager/${MANAGER_ID}`;
const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };
const options: CoreOptions = {
  region: "us-east-1",
  endpointUrl: "https://example.test/payments",
  credentials,
};
const config = { region: options.region, endpoint: options.endpointUrl, credentials };
const timestamp = new Date("2026-09-01T00:00:00Z");
const manager: GetPaymentManagerResponse = {
  paymentManagerArn: MANAGER_ARN,
  paymentManagerId: MANAGER_ID,
  name: "Checkout",
  authorizerType: "AWS_IAM",
  roleArn: "arn:aws:iam::123456789012:role/Payments",
  createdAt: timestamp,
  lastUpdatedAt: timestamp,
  status: "READY",
};
const connector: GetPaymentConnectorResponse = {
  paymentConnectorId: "connector-1",
  name: "Coinbase",
  type: "CoinbaseCDP",
  credentialProviderConfigurations: [],
  createdAt: timestamp,
  lastUpdatedAt: timestamp,
  status: "PENDING_AUTHENTICATION",
  authorizationUrl: "https://example.test/authorize",
};

interface SdkCommand {
  constructor: { name: string };
  input: unknown;
}
type Send = (command: SdkCommand) => Promise<unknown>;

const unexpected: Send = async (command) => {
  throw new Error(`unexpected ${command.constructor.name}`);
};

function paymentClient(sends: { control?: Send; data?: Send } = {}) {
  const controlSend = mock(sends.control ?? unexpected);
  const dataSend = mock(sends.data ?? unexpected);
  const control = mock(
    (_config: ClientConfig) =>
      ({ send: controlSend }) as unknown as ReturnType<AwsClients["control"]>,
  );
  const data = mock(
    (_config: ClientConfig) => ({ send: dataSend }) as unknown as ReturnType<AwsClients["data"]>,
  );
  const client = new PaymentClient(
    {
      control,
      data,
      iam: () => {
        throw new Error("unexpected IAM client");
      },
    },
    {
      getPaymentCredentialProvider: async () => {
        throw new Error("unexpected provider lookup");
      },
    },
  );
  return { client, control, data, controlSend, dataSend };
}

function serviceError(name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: { requestId: "request-1", httpStatusCode: 400 },
  });
}

const controlReads = [
  {
    command: GetPaymentManagerCommand,
    input: { paymentManagerId: MANAGER_ID },
    response: manager,
    run: (client: CorePaymentClient) => client.getPaymentManager(MANAGER_ID, options),
  },
  {
    command: ListPaymentManagersCommand,
    input: { nextToken: "page-2", maxResults: 5 },
    response: { paymentManagers: [manager], nextToken: "page-3" },
    run: (client: CorePaymentClient) => client.listPaymentManagers("page-2", 5, options),
  },
  {
    command: GetPaymentConnectorCommand,
    input: { paymentManagerId: MANAGER_ID, paymentConnectorId: "connector-1" },
    response: connector,
    run: (client: CorePaymentClient) =>
      client.getPaymentConnector(MANAGER_ID, "connector-1", options),
  },
  {
    command: ListPaymentConnectorsCommand,
    input: { paymentManagerId: MANAGER_ID, nextToken: "page-2", maxResults: 5 },
    response: { paymentConnectors: [connector], nextToken: "page-3" },
    run: (client: CorePaymentClient) =>
      client.listPaymentConnectors(MANAGER_ID, "page-2", 5, options),
  },
];

describe("PaymentClient control-plane reads", () => {
  test.each(controlReads)(
    "$command.name preserves request, response, and configured context",
    async ({ command, input, response, run }) => {
      const { client, control, controlSend, data } = paymentClient({
        control: async () => response,
      });
      await expect(run(client)).resolves.toBe(response);
      expect(controlSend).toHaveBeenCalledTimes(1);
      const sent = controlSend.mock.calls[0]![0];
      expect(sent).toBeInstanceOf(command);
      expect(sent.input).toEqual(input);
      expect(control).toHaveBeenCalledWith(config);
      expect(data).not.toHaveBeenCalled();
    },
  );

  test.each(controlReads)(
    "$command.name preserves the original service error without retrying",
    async ({ run }) => {
      const error = serviceError("AccessDeniedException", "control-plane failure");
      const { client, controlSend, data } = paymentClient({
        control: async () => {
          throw error;
        },
      });
      await expect(run(client)).rejects.toBe(error);
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(data).not.toHaveBeenCalled();
    },
  );

  test("manager and connector lists allow omitted pagination", async () => {
    const { client, controlSend } = paymentClient({ control: async () => ({}) });
    await client.listPaymentManagers(undefined, undefined, { region: "us-west-2" });
    await client.listPaymentConnectors(MANAGER_ID, undefined, undefined, { region: "us-west-2" });
    expect(controlSend.mock.calls.map(([command]) => command.input)).toEqual([
      { nextToken: undefined, maxResults: undefined },
      { paymentManagerId: MANAGER_ID, nextToken: undefined, maxResults: undefined },
    ]);
  });
});

const scoped = { managerId: MANAGER_ID, userId: "alice", agentName: "checkout-agent" };
const session = { ...scoped, paymentSessionId: "session-1" };
const sessionList = { ...scoped, nextToken: "page-2", maxResults: 5 };
const instrument = {
  ...scoped,
  paymentConnectorId: "connector-1",
  paymentInstrumentId: "instrument-1",
};
const instrumentList = {
  ...scoped,
  paymentConnectorId: "connector-1",
  nextToken: "page-2",
  maxResults: 2,
};
const balance = { ...instrument, chain: "BASE_SEPOLIA" as const, token: "USDC" as const };
const paymentSession: PaymentSession = {
  paymentSessionId: "session-1",
  paymentManagerArn: MANAGER_ARN,
  userId: "alice",
  expiryTimeInMinutes: 60,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const paymentInstrument: PaymentInstrument = {
  paymentInstrumentId: "instrument-1",
  paymentManagerArn: MANAGER_ARN,
  paymentConnectorId: "connector-1",
  userId: "alice",
  paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
  paymentInstrumentDetails: undefined,
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const balanceResponse: GetPaymentInstrumentBalanceResponse = {
  paymentInstrumentId: "instrument-1",
  tokenBalance: {
    amount: "123456789012345678901234567890",
    decimals: 6,
    network: "ETHEREUM",
    chain: "BASE_SEPOLIA",
    token: "USDC",
  },
};
const dataReads = [
  {
    command: GetPaymentSessionCommand,
    input: session,
    response: { paymentSession },
    run: (client: CorePaymentClient, managerId = MANAGER_ID) =>
      client.getPaymentSession({ ...session, managerId }, options),
  },
  {
    command: ListPaymentSessionsCommand,
    input: sessionList,
    response: { paymentSessions: [paymentSession], nextToken: "page-3" },
    run: (client: CorePaymentClient, managerId = MANAGER_ID) =>
      client.listPaymentSessions({ ...sessionList, managerId }, options),
  },
  {
    command: GetPaymentInstrumentCommand,
    input: instrument,
    response: { paymentInstrument },
    run: (client: CorePaymentClient, managerId = MANAGER_ID) =>
      client.getPaymentInstrument({ ...instrument, managerId }, options),
  },
  {
    command: ListPaymentInstrumentsCommand,
    input: instrumentList,
    response: { paymentInstruments: [paymentInstrument], nextToken: "page-3" },
    run: (client: CorePaymentClient, managerId = MANAGER_ID) =>
      client.listPaymentInstruments({ ...instrumentList, managerId }, options),
  },
  {
    command: GetPaymentInstrumentBalanceCommand,
    input: balance,
    response: balanceResponse,
    run: (client: CorePaymentClient, managerId = MANAGER_ID) =>
      client.getPaymentInstrumentBalance({ ...balance, managerId }, options),
  },
];

for (const { command, input, response, run } of dataReads) {
  describe(`PaymentClient ${command.name}`, () => {
    test("resolves the ID once before sending the unchanged request with the returned ARN", async () => {
      const calls: string[] = [];
      const { client, control, data, controlSend, dataSend } = paymentClient({
        control: async (sent) => {
          calls.push(sent.constructor.name);
          expect(sent).toBeInstanceOf(GetPaymentManagerCommand);
          expect(sent.input).toEqual({ paymentManagerId: MANAGER_ID });
          return manager;
        },
        data: async (sent) => {
          calls.push(sent.constructor.name);
          expect(sent).toBeInstanceOf(command);
          const { managerId: _managerId, ...request } = input;
          expect(sent.input).toEqual({ ...request, paymentManagerArn: MANAGER_ARN });
          expect(sent.input).not.toHaveProperty("managerId");
          return response;
        },
      });

      await expect(run(client)).resolves.toBe(response);
      expect(calls).toEqual(["GetPaymentManagerCommand", command.name]);
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(dataSend).toHaveBeenCalledTimes(1);
      expect(control).toHaveBeenCalledWith(config);
      expect(data).toHaveBeenCalledWith(config);
      expect(input).toHaveProperty("managerId", MANAGER_ID);
      expect(input).not.toHaveProperty("paymentManagerArn");
    });

    test("rejects an ARN used as an ID before configuring either SDK client", async () => {
      const { client, control, data } = paymentClient();
      const failure = run(client, MANAGER_ARN);
      await expect(failure).rejects.toBeInstanceOf(InputValidationError);
      await expect(failure).rejects.toThrow(/manager ID, not an ARN/);
      expect(control).not.toHaveBeenCalled();
      expect(data).not.toHaveBeenCalled();
    });

    test("rejects CUSTOM_JWT before configuring the data client", async () => {
      const { client, controlSend, data } = paymentClient({
        control: async () => ({ ...manager, authorizerType: "CUSTOM_JWT" }),
      });
      const failure = run(client);
      await expect(failure).rejects.toBeInstanceOf(InputValidationError);
      await expect(failure).rejects.toThrow(new RegExp(`${MANAGER_ID}.*CUSTOM_JWT`));
      await expect(failure).rejects.toThrow(/bearer token/);
      await expect(failure).rejects.toMatchObject({ source: ERROR_SOURCE.USER });
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(data).not.toHaveBeenCalled();
    });

    test.each([undefined, ""])("rejects a missing manager ARN (%s)", async (paymentManagerArn) => {
      const { client, controlSend, data } = paymentClient({
        control: async () => ({ ...manager, paymentManagerArn }),
      });
      const failure = run(client);
      await expect(failure).rejects.toBeInstanceOf(MalformedServiceResponseError);
      await expect(failure).rejects.toThrow(/returned no ARN/);
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(data).not.toHaveBeenCalled();
    });

    test.each(["ResourceNotFoundException", "AccessDeniedException"])(
      "preserves a lookup %s and stops before data-plane access",
      async (name) => {
        const error = serviceError(name, "GetPaymentManager failed");
        const { client, control, controlSend, data } = paymentClient({
          control: async () => {
            throw error;
          },
        });
        await expect(run(client)).rejects.toBe(error);
        expect(control).toHaveBeenCalledWith(config);
        expect(controlSend).toHaveBeenCalledTimes(1);
        expect(data).not.toHaveBeenCalled();
      },
    );

    test.each(["AccessDeniedException", "ValidationException", "ThrottlingException"])(
      "preserves a data-plane %s without a second lookup or fallback response",
      async (name) => {
        const error = serviceError(name, "data-plane failure");
        const { client, controlSend, dataSend } = paymentClient({
          control: async () => manager,
          data: async () => {
            throw error;
          },
        });
        await expect(run(client)).rejects.toBe(error);
        expect(controlSend).toHaveBeenCalledTimes(1);
        expect(dataSend).toHaveBeenCalledTimes(1);
      },
    );
  });
}

describe("PaymentClient read boundaries", () => {
  test("balance retains an atomic amount beyond numeric precision and its decimals", async () => {
    const { client } = paymentClient({
      control: async () => manager,
      data: async () => balanceResponse,
    });
    const result = await client.getPaymentInstrumentBalance(balance, options);
    expect(result).toBe(balanceResponse);
    expect(result.tokenBalance?.amount).toBe("123456789012345678901234567890");
    expect(result.tokenBalance?.decimals).toBe(6);
  });

  test("each call resolves the manager again and uses the latest returned ARN", async () => {
    const latestArn =
      "arn:aws:bedrock-agentcore:eu-west-1:123456789012:payment-manager/checkout-current";
    let lookups = 0;
    const { client, controlSend, data, dataSend } = paymentClient({
      control: async () => ({
        ...manager,
        paymentManagerArn: ++lookups === 1 ? MANAGER_ARN : latestArn,
      }),
      data: async () => balanceResponse,
    });
    await client.getPaymentInstrumentBalance(balance, options);
    await client.getPaymentInstrumentBalance(balance, options);
    expect(controlSend).toHaveBeenCalledTimes(2);
    const { managerId: _managerId, ...request } = balance;
    expect(dataSend.mock.calls.map(([command]) => command.input)).toEqual([
      { ...request, paymentManagerArn: MANAGER_ARN },
      { ...request, paymentManagerArn: latestArn },
    ]);
    expect(data.mock.calls.map(([clientConfig]) => clientConfig)).toEqual([config, config]);
  });

  test("does not cache manager authorization across calls", async () => {
    let lookups = 0;
    const { client, controlSend, dataSend } = paymentClient({
      control: async () => ({
        ...manager,
        authorizerType: ++lookups === 1 ? "AWS_IAM" : "CUSTOM_JWT",
      }),
      data: async () => balanceResponse,
    });
    await client.getPaymentInstrumentBalance(balance, options);
    await expect(client.getPaymentInstrumentBalance(balance, options)).rejects.toThrow(
      /CUSTOM_JWT/,
    );
    expect(controlSend).toHaveBeenCalledTimes(2);
    expect(dataSend).toHaveBeenCalledTimes(1);
  });

  test("session and instrument lists preserve optional field omission and default client context", async () => {
    const { client, control, data, dataSend } = paymentClient({
      control: async () => manager,
      data: async () => ({}),
    });
    await client.listPaymentSessions({ managerId: MANAGER_ID }, { region: "us-west-2" });
    await client.listPaymentInstruments({ managerId: MANAGER_ID }, { region: "us-west-2" });
    expect(dataSend.mock.calls.map(([command]) => command.input)).toEqual([
      { paymentManagerArn: MANAGER_ARN },
      { paymentManagerArn: MANAGER_ARN },
    ]);
    expect(control.mock.calls.map(([clientConfig]) => clientConfig)).toEqual([
      { region: "us-west-2" },
      { region: "us-west-2" },
    ]);
    expect(data.mock.calls.map(([clientConfig]) => clientConfig)).toEqual([
      { region: "us-west-2" },
      { region: "us-west-2" },
    ]);
  });
});
