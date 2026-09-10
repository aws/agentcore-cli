import { describe, expect, mock, test } from "bun:test";
import {
  CreatePaymentConnectorCommand,
  CreatePaymentManagerCommand,
  DeletePaymentManagerCommand,
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  UpdatePaymentConnectorCommand,
  type GetPaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreatePaymentInstrumentCommand,
  CreatePaymentSessionCommand,
  DeletePaymentInstrumentCommand,
  DeletePaymentSessionCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { ERROR_SOURCE, InputValidationError } from "../errors";
import type { CoreIdentityClient } from "../handlers/identity/types";
import { PaymentClient } from "./payment";
import type { AwsClients } from "./types";

const options = { region: "us-west-2" };
const ACCOUNT = "123456789012";
const DEFAULT_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/AgentCorePayments-us-west-2-Checkout`;
const MANAGER_ID = "checkout-abc1234567";
const MANAGER_ARN = `arn:aws:bedrock-agentcore:us-west-2:${ACCOUNT}:payment-manager/${MANAGER_ID}`;
const PROVIDER_ARN = `arn:aws:bedrock-agentcore:us-west-2:${ACCOUNT}:token-vault/default/paymentcredentialprovider/cdp-creds`;

interface SdkCommand {
  constructor: { name: string };
  input: unknown;
}
type Send = (command: SdkCommand) => Promise<unknown>;

const unexpected: Send = async (command) => {
  throw new Error(`unexpected ${command.constructor.name}`);
};

// paymentClient wires a PaymentClient over fake SDK clients whose `.send()` is
// the supplied function, plus a partial identity client for name resolution.
function paymentClient(
  sends: { control?: Send; data?: Send; iam?: Send },
  identity: Partial<CoreIdentityClient> = {},
): PaymentClient {
  const client =
    (send: Send = unexpected) =>
    () =>
      ({ send: mock(send) }) as never;
  return new PaymentClient(
    {
      control: client(sends.control),
      data: client(sends.data),
      iam: client(sends.iam),
    } as unknown as AwsClients,
    identity as CoreIdentityClient,
  );
}

function serviceError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, extra);
  return error;
}

function coinbaseProvider(name: string): GetPaymentCredentialProviderResponse {
  return {
    name,
    credentialProviderArn: PROVIDER_ARN,
    credentialProviderVendor: "CoinbaseCDP",
  } as GetPaymentCredentialProviderResponse;
}

describe("PaymentClient manager", () => {
  test("createPaymentManager passes an explicit role through without touching IAM", async () => {
    const client = paymentClient({
      control: async (command) => {
        expect(command).toBeInstanceOf(CreatePaymentManagerCommand);
        expect(command.input).toEqual({
          name: "Checkout",
          authorizerType: "AWS_IAM",
          roleArn: "arn:aws:iam::123456789012:role/MyRole",
        });
        return { paymentManagerId: MANAGER_ID };
      },
    });

    await expect(
      client.createPaymentManager(
        {
          name: "Checkout",
          authorizerType: "AWS_IAM",
          roleArn: "arn:aws:iam::123456789012:role/MyRole",
        },
        options,
      ),
    ).resolves.toMatchObject({ paymentManagerId: MANAGER_ID });
  });

  test("createPaymentManager provisions the default service role when none is given", async () => {
    const iamCalls: string[] = [];
    const client = paymentClient({
      iam: async (command) => {
        iamCalls.push(command.constructor.name);
        if (command instanceof GetRoleCommand) {
          throw serviceError("NoSuchEntityException", "role does not exist");
        }
        if (command instanceof CreateRoleCommand) {
          expect(command.input).toMatchObject({ RoleName: "AgentCorePayments-us-west-2-Checkout" });
          return { Role: { Arn: DEFAULT_ROLE_ARN } };
        }
        if (command instanceof PutRolePolicyCommand) return {};
        throw new Error(`unexpected ${command.constructor.name}`);
      },
      control: async (command) => {
        expect(command).toBeInstanceOf(CreatePaymentManagerCommand);
        expect(command.input).toEqual({
          name: "Checkout",
          authorizerType: "AWS_IAM",
          roleArn: DEFAULT_ROLE_ARN,
        });
        return { paymentManagerId: MANAGER_ID };
      },
    });

    await client.createPaymentManager({ name: "Checkout", authorizerType: "AWS_IAM" }, options);
    expect(iamCalls).toEqual(["GetRoleCommand", "CreateRoleCommand", "PutRolePolicyCommand"]);
  });

  // IAM's own denial message ("assumed-role/... is not authorized") mentions a role
  // too, so the propagation retry must key on the provisioned role, not on the
  // word. An under-privileged caller gets the real error on the first attempt.
  test("createPaymentManager does not retry a caller's own access denial", async () => {
    let creates = 0;
    const client = paymentClient({
      iam: async (command) => {
        if (command instanceof GetRoleCommand) {
          return {
            Role: {
              Arn: DEFAULT_ROLE_ARN,
              Tags: [
                { Key: "agentcore:managed-by", Value: "agentcore-cli" },
                { Key: "agentcore:payment-manager", Value: "Checkout" },
                { Key: "agentcore:region", Value: options.region },
              ],
            },
          };
        }
        return {};
      },
      control: async () => {
        creates++;
        throw serviceError(
          "AccessDeniedException",
          `User: arn:aws:sts::${ACCOUNT}:assumed-role/Admin/session is not authorized to perform: bedrock-agentcore:CreatePaymentManager`,
        );
      },
    });

    await expect(
      client.createPaymentManager({ name: "Checkout", authorizerType: "AWS_IAM" }, options),
    ).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(creates).toBe(1);
  });

  test("default role provisioning retains explicit credentials but not the AgentCore endpoint", async () => {
    const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };
    const iam = mock(() => {
      throw new Error("captured IAM configuration");
    });
    const control = mock(() => ({ send: unexpected }));
    const client = new PaymentClient({ iam, control } as unknown as AwsClients, {
      getPaymentCredentialProvider: async () => coinbaseProvider("unused"),
    });
    await expect(
      client.createPaymentManager(
        { name: "Checkout", authorizerType: "AWS_IAM" },
        { region: options.region, endpointUrl: "https://example.test/control", credentials },
      ),
    ).rejects.toThrow("captured IAM configuration");
    expect(iam).toHaveBeenCalledWith({ region: options.region, credentials });
    expect(control).toHaveBeenCalledWith({
      region: options.region,
      endpoint: "https://example.test/control",
      credentials,
    });
  });

  test("deletePaymentManager forwards the id and client token", async () => {
    const client = paymentClient({
      control: async (command) => {
        expect(command).toBeInstanceOf(DeletePaymentManagerCommand);
        expect(command.input).toEqual({ paymentManagerId: MANAGER_ID, clientToken: "tok" });
        return { status: "DELETING", paymentManagerId: MANAGER_ID };
      },
    });

    await expect(
      client.deletePaymentManager({ paymentManagerId: MANAGER_ID, clientToken: "tok" }, options),
    ).resolves.toEqual({ status: "DELETING", paymentManagerId: MANAGER_ID });
  });
});

describe("PaymentClient connector create", () => {
  test("Quick Create sends an empty credential list and the QUICK_CREATE provision mode", async () => {
    const client = paymentClient({
      control: async (command) => {
        expect(command).toBeInstanceOf(CreatePaymentConnectorCommand);
        expect(command.input).toEqual({
          paymentManagerId: MANAGER_ID,
          name: "Coinbase",
          type: "CoinbaseCDP",
          credentialProviderConfigurations: [],
          provisionMode: "QUICK_CREATE",
        });
        return { paymentConnectorId: "coinbase-xyz", status: "PENDING_AUTHENTICATION" };
      },
    });

    await expect(
      client.createPaymentConnector(
        { managerId: MANAGER_ID, name: "Coinbase", quickCreate: true },
        options,
      ),
    ).resolves.toMatchObject({ status: "PENDING_AUTHENTICATION" });
  });

  test("Quick Create rejects any type other than CoinbaseCDP before calling the service", async () => {
    const client = paymentClient({});
    await expect(
      client.createPaymentConnector(
        { managerId: MANAGER_ID, name: "Privy", quickCreate: true, type: "StripePrivy" },
        options,
      ),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("a credential provider named by name is resolved through identity and sets the type from its vendor", async () => {
    const identity = {
      getPaymentCredentialProvider: mock(async (name: string) => coinbaseProvider(name)),
    };
    const client = paymentClient(
      {
        control: async (command) => {
          expect(command).toBeInstanceOf(CreatePaymentConnectorCommand);
          expect(command.input).toEqual({
            paymentManagerId: MANAGER_ID,
            name: "Coinbase",
            description: "manual",
            type: "CoinbaseCDP",
            credentialProviderConfigurations: [
              { coinbaseCDP: { credentialProviderArn: PROVIDER_ARN } },
            ],
            provisionMode: undefined,
          });
          return { paymentConnectorId: "coinbase-xyz", status: "CREATING" };
        },
      },
      identity,
    );

    await client.createPaymentConnector(
      {
        managerId: MANAGER_ID,
        name: "Coinbase",
        description: "manual",
        credentialProvider: "cdp-creds",
      },
      options,
    );
    expect(identity.getPaymentCredentialProvider).toHaveBeenCalledWith("cdp-creds", options);
  });

  test("a credential provider ARN requires an explicit type and selects the matching union member", async () => {
    const client = paymentClient({
      control: async (command) => {
        expect(command.input).toMatchObject({
          type: "StripePrivy",
          credentialProviderConfigurations: [
            { stripePrivy: { credentialProviderArn: PROVIDER_ARN } },
          ],
        });
        return { status: "CREATING" };
      },
    });

    await expect(
      client.createPaymentConnector(
        { managerId: MANAGER_ID, name: "Privy", credentialProvider: PROVIDER_ARN },
        options,
      ),
    ).rejects.toThrow(/--type/);

    await client.createPaymentConnector(
      {
        managerId: MANAGER_ID,
        name: "Privy",
        credentialProvider: PROVIDER_ARN,
        type: "StripePrivy",
      },
      options,
    );
  });

  test("an explicit type that contradicts the provider's vendor is rejected", async () => {
    const client = paymentClient(
      {},
      { getPaymentCredentialProvider: async (name: string) => coinbaseProvider(name) },
    );
    await expect(
      client.createPaymentConnector(
        {
          managerId: MANAGER_ID,
          name: "Mismatch",
          credentialProvider: "cdp-creds",
          type: "StripePrivy",
        },
        options,
      ),
    ).rejects.toThrow(/CoinbaseCDP/);
  });

  test("neither Quick Create nor a credential provider is an input error", async () => {
    const client = paymentClient({});
    await expect(
      client.createPaymentConnector({ managerId: MANAGER_ID, name: "Nothing" }, options),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("a Marketplace subscription failure surfaces the product and subscription URL", async () => {
    const client = paymentClient({
      control: async () => {
        throw serviceError("SubscriptionRequiredException", "Subscription required", {
          subscriptionUrl: "https://aws.amazon.com/marketplace/pp/prodview-example",
          productName: "Coinbase Wallets for AgentCore Payments",
        });
      },
    });

    const failure = client.createPaymentConnector(
      { managerId: MANAGER_ID, name: "Coinbase", quickCreate: true },
      options,
    );
    await expect(failure).rejects.toThrow(/Coinbase Wallets for AgentCore Payments/);
    await expect(failure).rejects.toThrow(/prodview-example/);
    await expect(failure).rejects.toMatchObject({
      name: "SubscriptionRequiredException",
      source: ERROR_SOURCE.USER,
    });
  });
});

describe("PaymentClient connector update", () => {
  test("replacing the credential provider reads the connector type to pick the union member", async () => {
    const sent: string[] = [];
    const client = paymentClient(
      {
        control: async (command) => {
          sent.push(command.constructor.name);
          if (command instanceof GetPaymentConnectorCommand) {
            expect(command.input).toEqual({
              paymentManagerId: MANAGER_ID,
              paymentConnectorId: "coinbase-xyz",
            });
            return { type: "CoinbaseCDP" };
          }
          expect(command).toBeInstanceOf(UpdatePaymentConnectorCommand);
          expect(command.input).toEqual({
            paymentManagerId: MANAGER_ID,
            paymentConnectorId: "coinbase-xyz",
            description: "rotated",
            credentialProviderConfigurations: [
              { coinbaseCDP: { credentialProviderArn: PROVIDER_ARN } },
            ],
            clientToken: undefined,
          });
          return { status: "UPDATING" };
        },
      },
      { getPaymentCredentialProvider: async (name: string) => coinbaseProvider(name) },
    );

    await client.updatePaymentConnector(
      {
        managerId: MANAGER_ID,
        connectorId: "coinbase-xyz",
        description: "rotated",
        credentialProvider: "cdp-creds",
      },
      options,
    );
    expect(sent).toEqual(["GetPaymentConnectorCommand", "UpdatePaymentConnectorCommand"]);
  });

  test("a description-only update sends no credential configuration and skips the lookup", async () => {
    const client = paymentClient({
      control: async (command) => {
        expect(command).toBeInstanceOf(UpdatePaymentConnectorCommand);
        expect(command.input).toEqual({
          paymentManagerId: MANAGER_ID,
          paymentConnectorId: "coinbase-xyz",
          description: "renamed",
          credentialProviderConfigurations: undefined,
          clientToken: undefined,
        });
        return { status: "UPDATING" };
      },
    });

    await client.updatePaymentConnector(
      { managerId: MANAGER_ID, connectorId: "coinbase-xyz", description: "renamed" },
      options,
    );
  });
});

describe("PaymentClient data plane", () => {
  test("rejects a manager ARN used as an ID before any SDK call", async () => {
    const client = paymentClient({});
    await expect(
      client.listPaymentSessions({ managerId: MANAGER_ARN, userId: "alice" }, options),
    ).rejects.toThrow(/manager ID, not an ARN/);
  });

  test("createPaymentSession resolves the manager ID before sending the request", async () => {
    const request = {
      managerId: MANAGER_ID,
      userId: "alice",
      expiryTimeInMinutes: 60,
      limits: { maxSpendAmount: { value: "10.00", currency: "USD" as const } },
    };
    const sent: string[] = [];
    const client = paymentClient({
      control: async (command) => {
        sent.push(command.constructor.name);
        expect(command).toBeInstanceOf(GetPaymentManagerCommand);
        expect(command.input).toEqual({ paymentManagerId: MANAGER_ID });
        return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
      },
      data: async (command) => {
        sent.push(command.constructor.name);
        expect(command).toBeInstanceOf(CreatePaymentSessionCommand);
        const { managerId: _managerId, ...rest } = request;
        expect(command.input).toEqual({ ...rest, paymentManagerArn: MANAGER_ARN });
        return { paymentSession: { paymentSessionId: "session-1" } };
      },
    });

    await expect(client.createPaymentSession(request, options)).resolves.toMatchObject({
      paymentSession: { paymentSessionId: "session-1" },
    });
    expect(sent).toEqual(["GetPaymentManagerCommand", "CreatePaymentSessionCommand"]);
  });

  test("a CUSTOM_JWT manager is rejected before contacting the data plane", async () => {
    let dataCalls = 0;
    const client = paymentClient({
      data: async () => {
        dataCalls++;
        return {};
      },
      control: async (command) => {
        expect(command).toBeInstanceOf(GetPaymentManagerCommand);
        expect(command.input).toEqual({ paymentManagerId: MANAGER_ID });
        return { paymentManagerArn: MANAGER_ARN, authorizerType: "CUSTOM_JWT" };
      },
    });

    const failure = client.listPaymentSessions({ managerId: MANAGER_ID, userId: "alice" }, options);
    await expect(failure).rejects.toThrow(new RegExp(`${MANAGER_ID}.*CUSTOM_JWT`));
    await expect(failure).rejects.toThrow(/bearer token/);
    await expect(failure).rejects.toMatchObject({ source: ERROR_SOURCE.USER });
    expect(dataCalls).toBe(0);
  });

  test.each(["ResourceNotFoundException", "AccessDeniedException"])(
    "a manager lookup %s is preserved and prevents the data-plane call",
    async (name) => {
      const error = serviceError(name, "GetPaymentManager failed");
      let dataCalls = 0;
      const client = paymentClient({
        control: async () => {
          throw error;
        },
        data: async () => {
          dataCalls++;
          return {};
        },
      });
      await expect(
        client.listPaymentSessions({ managerId: MANAGER_ID, userId: "alice" }, options),
      ).rejects.toBe(error);
      expect(dataCalls).toBe(0);
    },
  );

  test.each(["AccessDeniedException", "ValidationException", "ThrottlingException"])(
    "a data-plane %s is preserved without a second manager lookup",
    async (name) => {
      const error = serviceError(name, "data-plane failure");
      let lookups = 0;
      const client = paymentClient({
        control: async () => {
          lookups++;
          return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
        },
        data: async () => {
          throw error;
        },
      });
      await expect(
        client.listPaymentSessions({ managerId: MANAGER_ID, userId: "alice" }, options),
      ).rejects.toBe(error);
      expect(lookups).toBe(1);
    },
  );

  test("a manager response without an ARN fails before data-plane access", async () => {
    let dataCalls = 0;
    const client = paymentClient({
      control: async () => ({ authorizerType: "AWS_IAM" }),
      data: async () => {
        dataCalls++;
        return {};
      },
    });
    await expect(client.listPaymentSessions({ managerId: MANAGER_ID }, options)).rejects.toThrow(
      /ARN/,
    );
    expect(dataCalls).toBe(0);
  });

  test("list requests reach the data plane with pagination intact", async () => {
    const client = paymentClient({
      control: async () => ({ paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" }),
      data: async (command) => {
        expect(command).toBeInstanceOf(ListPaymentSessionsCommand);
        expect(command.input).toEqual({
          paymentManagerArn: MANAGER_ARN,
          userId: "alice",
          nextToken: "page-2",
          maxResults: 5,
        });
        return { paymentSessions: [], nextToken: undefined };
      },
    });

    await client.listPaymentSessions(
      { managerId: MANAGER_ID, userId: "alice", nextToken: "page-2", maxResults: 5 },
      options,
    );
  });

  const scoped = { managerId: MANAGER_ID, userId: "alice" };
  const session = { ...scoped, paymentSessionId: "session-1" };
  const instrument = {
    ...scoped,
    paymentConnectorId: "connector-1",
    paymentInstrumentId: "instrument-1",
  };
  const wallet = {
    ...scoped,
    paymentConnectorId: "connector-1",
    paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET" as const,
    paymentInstrumentDetails: {
      embeddedCryptoWallet: {
        network: "ETHEREUM" as const,
        linkedAccounts: [{ email: { emailAddress: "alice@example.test" } }],
      },
    },
  };
  const balance = { ...instrument, chain: "BASE_SEPOLIA" as const, token: "USDC" as const };
  const instrumentList = {
    ...scoped,
    paymentConnectorId: "connector-1",
    nextToken: "page-2",
    maxResults: 2,
  };
  test.each([
    {
      command: GetPaymentSessionCommand,
      input: session,
      run: (c: PaymentClient) => c.getPaymentSession(session, options),
    },
    {
      command: DeletePaymentSessionCommand,
      input: session,
      run: (c: PaymentClient) => c.deletePaymentSession(session, options),
    },
    {
      command: CreatePaymentInstrumentCommand,
      input: wallet,
      run: (c: PaymentClient) => c.createPaymentInstrument(wallet, options),
    },
    {
      command: GetPaymentInstrumentCommand,
      input: instrument,
      run: (c: PaymentClient) => c.getPaymentInstrument(instrument, options),
    },
    {
      command: DeletePaymentInstrumentCommand,
      input: instrument,
      run: (c: PaymentClient) => c.deletePaymentInstrument(instrument, options),
    },
    {
      command: GetPaymentInstrumentBalanceCommand,
      input: balance,
      run: (c: PaymentClient) => c.getPaymentInstrumentBalance(balance, options),
    },
    {
      command: ListPaymentInstrumentsCommand,
      input: instrumentList,
      run: (c: PaymentClient) => c.listPaymentInstruments(instrumentList, options),
    },
  ])(
    "$command.name resolves the manager once and preserves the request",
    async ({ command, input, run }) => {
      const calls: string[] = [];
      const client = paymentClient({
        control: async (sent) => {
          calls.push(sent.constructor.name);
          expect(sent.input).toEqual({ paymentManagerId: MANAGER_ID });
          return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
        },
        data: async (sent) => {
          calls.push(sent.constructor.name);
          expect(sent).toBeInstanceOf(command);
          const { managerId: _id, ...request } = input;
          expect(sent.input).toEqual({ ...request, paymentManagerArn: MANAGER_ARN });
          expect(input).toHaveProperty("managerId", MANAGER_ID);
          expect(input).not.toHaveProperty("paymentManagerArn");
          return {};
        },
      });
      await run(client);
      expect(calls).toEqual(["GetPaymentManagerCommand", command.name]);
    },
  );

  test("manager lookup and data call retain the same region, endpoint, and credentials", async () => {
    const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };
    const config = { region: "us-east-1", endpoint: "https://example.test/payments", credentials };
    const control = mock(() => ({
      send: async () => ({ paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" }),
    }));
    const data = mock(() => ({ send: async () => ({}) }));
    const client = new PaymentClient({ control, data } as unknown as AwsClients, {
      getPaymentCredentialProvider: async () => coinbaseProvider("unused"),
    });
    await client.getPaymentInstrumentBalance(balance, {
      region: config.region,
      endpointUrl: config.endpoint,
      credentials,
    });
    expect(control).toHaveBeenCalledWith(config);
    expect(data).toHaveBeenCalledWith(config);
  });
});
