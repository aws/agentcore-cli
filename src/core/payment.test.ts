import { expect, mock, test } from "bun:test";
import {
  CreatePaymentManagerCommand,
  GetPaymentConnectorCommand,
  UpdatePaymentConnectorCommand,
  type GetPaymentCredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { GetRoleCommand } from "@aws-sdk/client-iam";
import { PaymentClient } from "./payment";
import type { AwsClients } from "./types";

const options = { region: "us-west-2" };
const ROLE_ARN = "arn:aws:iam::123456789012:role/AgentCorePayments-us-west-2-Checkout";
const PROVIDER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/paymentcredentialprovider/cdp-creds";
const connector = { managerId: "manager", name: "Coinbase" };
const provider = {
  credentialProviderArn: PROVIDER_ARN,
  credentialProviderVendor: "CoinbaseCDP",
} as GetPaymentCredentialProviderResponse;
type Send = (command: { input: unknown }) => Promise<unknown>;

function setup(controlSend: Send = async () => ({}), iamSend?: Send) {
  const unexpected = () => {
    throw new Error("Unexpected SDK call");
  };
  const send = mock(controlSend);
  const identity = { getPaymentCredentialProvider: mock(async (_name: string) => provider) };
  const clients = {
    control: () => ({ send }),
    data: unexpected,
    iam: iamSend ? () => ({ send: iamSend }) : unexpected,
  } as unknown as AwsClients;
  return { client: new PaymentClient(clients, identity), send, identity };
}

test("an explicit manager role bypasses IAM provisioning", async () => {
  const { client, send } = setup();
  const input = { name: "Checkout", authorizerType: "AWS_IAM" as const, roleArn: ROLE_ARN };
  await client.createPaymentManager(input, options);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CreatePaymentManagerCommand);
  expect(send.mock.calls[0]?.[0].input).toEqual(input);
});

test("a caller's access denial is not mistaken for service-role propagation", async () => {
  const error = Object.assign(
    new Error(
      "User: arn:aws:sts::123456789012:assumed-role/Admin/session is not authorized to perform: bedrock-agentcore:CreatePaymentManager",
    ),
    { name: "AccessDeniedException" },
  );
  const { client, send } = setup(
    async () => {
      throw error;
    },
    async (command) =>
      command instanceof GetRoleCommand
        ? {
            Role: {
              Arn: ROLE_ARN,
              Tags: [
                { Key: "agentcore:managed-by", Value: "agentcore-cli" },
                { Key: "agentcore:payment-manager", Value: "Checkout" },
                { Key: "agentcore:region", Value: options.region },
              ],
            },
          }
        : {},
  );
  await expect(
    client.createPaymentManager({ name: "Checkout", authorizerType: "AWS_IAM" }, options),
  ).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
});

test("IAM receives explicit credentials but not the AgentCore endpoint override", async () => {
  const credentials = { accessKeyId: "test-key", secretAccessKey: "test-secret" };
  const iam = mock(() => {
    throw new Error("captured IAM configuration");
  });
  const control = mock(() => ({ send: async () => ({}) }));
  const client = new PaymentClient({ iam, control } as unknown as AwsClients, {
    getPaymentCredentialProvider: async () => provider,
  });
  await expect(
    client.createPaymentManager(
      { name: "Checkout", authorizerType: "AWS_IAM" },
      { ...options, endpointUrl: "https://payments.example.test", credentials },
    ),
  ).rejects.toThrow("captured IAM configuration");
  expect(iam).toHaveBeenCalledWith({ ...options, credentials });
  expect(control).toHaveBeenCalledWith({
    ...options,
    endpoint: "https://payments.example.test",
    credentials,
  });
});

test("a named provider supplies its ARN and vendor; a conflicting vendor is rejected", async () => {
  const { client, send, identity } = setup();
  await client.createPaymentConnector({ ...connector, credentialProvider: "cdp-creds" }, options);
  expect(identity.getPaymentCredentialProvider).toHaveBeenCalledWith("cdp-creds", options);
  expect(send.mock.calls[0]?.[0].input).toEqual({
    paymentManagerId: "manager",
    name: "Coinbase",
    type: "CoinbaseCDP",
    credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn: PROVIDER_ARN } }],
    provisionMode: undefined,
  });
  await expect(
    client.createPaymentConnector(
      {
        ...connector,
        credentialProvider: "cdp-creds",
        type: "StripePrivy",
      },
      options,
    ),
  ).rejects.toThrow("cannot back a StripePrivy connector");
  expect(send).toHaveBeenCalledTimes(1);
});

test("a provider ARN requires a vendor and skips name resolution", async () => {
  const { client, send, identity } = setup();
  await expect(
    client.createPaymentConnector(
      {
        ...connector,
        credentialProvider: PROVIDER_ARN,
      },
      options,
    ),
  ).rejects.toThrow("--type is required");
  await client.createPaymentConnector(
    {
      ...connector,
      credentialProvider: PROVIDER_ARN,
      type: "StripePrivy",
    },
    options,
  );
  expect(send.mock.calls[0]?.[0].input).toMatchObject({
    type: "StripePrivy",
    credentialProviderConfigurations: [{ stripePrivy: { credentialProviderArn: PROVIDER_ARN } }],
  });
  expect(identity.getPaymentCredentialProvider).not.toHaveBeenCalled();
});

test("connector updates resolve replacement credentials but preserve omitted credentials", async () => {
  const { client, send, identity } = setup(async (command) =>
    command instanceof GetPaymentConnectorCommand ? { type: "CoinbaseCDP" } : {},
  );
  const input = { managerId: "manager", connectorId: "connector", description: "updated" };
  await client.updatePaymentConnector({ ...input, credentialProvider: "cdp-creds" }, options);
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    input: { paymentManagerId: "manager", paymentConnectorId: "connector" },
  });
  expect(send.mock.calls[1]?.[0]).toBeInstanceOf(UpdatePaymentConnectorCommand);
  expect(send.mock.calls[1]?.[0].input).toEqual({
    paymentManagerId: "manager",
    paymentConnectorId: "connector",
    description: "updated",
    credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn: PROVIDER_ARN } }],
    clientToken: undefined,
  });
  await client.updatePaymentConnector(input, options);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]?.[0]).toBeInstanceOf(UpdatePaymentConnectorCommand);
  expect(send.mock.calls[2]?.[0].input).toEqual({
    paymentManagerId: "manager",
    paymentConnectorId: "connector",
    description: "updated",
    credentialProviderConfigurations: undefined,
    clientToken: undefined,
  });
  expect(identity.getPaymentCredentialProvider).toHaveBeenCalledTimes(1);
});

test("Marketplace errors retain the subscription URL and product name", async () => {
  const error = Object.assign(new Error("Subscription required"), {
    name: "SubscriptionRequiredException",
    subscriptionUrl: "https://aws.amazon.com/marketplace/pp/prodview-example",
    productName: "Coinbase Wallets",
  });
  const { client } = setup(async () => {
    throw error;
  });
  const result = client.createPaymentConnector({ ...connector, quickCreate: true }, options);
  await expect(result).rejects.toThrow("Coinbase Wallets");
  await expect(result).rejects.toThrow(error.subscriptionUrl);
  await expect(result).rejects.toMatchObject({ cause: error, name: error.name });
});
