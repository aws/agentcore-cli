import { expect, mock, test } from "bun:test";
import { GetPaymentManagerCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { ListPaymentSessionsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { PaymentClient } from "./payment";
import type { AwsClients, ClientConfig } from "./types";

const MANAGER_ID = "checkout-abc1234567";
const MANAGER_ARN = `arn:aws:bedrock-agentcore:us-west-2:123456789012:payment-manager/${MANAGER_ID}`;
const request = { managerId: MANAGER_ID, userId: "alice" };
const options = {
  region: "us-east-1",
  endpointUrl: "https://payments.example.test",
  credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
};

function setup() {
  const controlSend = mock(async (_command: unknown) => ({
    paymentManagerArn: MANAGER_ARN,
    authorizerType: "AWS_IAM",
  }));
  const response = { paymentSessions: [] };
  const dataSend = mock(async (_command: unknown) => response);
  const control = mock(
    (_config: ClientConfig) =>
      ({ send: controlSend }) as unknown as ReturnType<AwsClients["control"]>,
  );
  const data = mock(
    (_config: ClientConfig) => ({ send: dataSend }) as unknown as ReturnType<AwsClients["data"]>,
  );
  return {
    client: new PaymentClient({ control, data }),
    control,
    data,
    controlSend,
    dataSend,
    response,
  };
}

test("resolves the manager in the configured region and forwards the returned ARN and context", async () => {
  const { client, control, data, controlSend, dataSend, response } = setup();
  const input = { ...request, agentName: "agent", nextToken: "page+2/=", maxResults: 5 };
  expect(await client.listPaymentSessions(input, options)).toBe(response);
  expect(controlSend.mock.calls[0]?.[0]).toBeInstanceOf(GetPaymentManagerCommand);
  expect(controlSend.mock.calls[0]?.[0]).toMatchObject({ input: { paymentManagerId: MANAGER_ID } });
  expect(dataSend.mock.calls[0]?.[0]).toBeInstanceOf(ListPaymentSessionsCommand);
  expect((dataSend.mock.calls[0]![0] as ListPaymentSessionsCommand).input).toEqual({
    paymentManagerArn: MANAGER_ARN,
    userId: "alice",
    agentName: "agent",
    nextToken: "page+2/=",
    maxResults: 5,
  });
  const config = {
    region: options.region,
    endpoint: options.endpointUrl,
    credentials: options.credentials,
  };
  expect(control).toHaveBeenCalledWith(config);
  expect(data).toHaveBeenCalledWith(config);

  controlSend.mockResolvedValueOnce({
    paymentManagerArn: `${MANAGER_ARN}-new`,
    authorizerType: "AWS_IAM",
  });
  await client.listPaymentSessions(request, options);
  expect(controlSend).toHaveBeenCalledTimes(2);
  expect(dataSend.mock.calls[1]?.[0]).toMatchObject({
    input: { paymentManagerArn: `${MANAGER_ARN}-new`, userId: "alice" },
  });
  expect(input).toEqual({ ...request, agentName: "agent", nextToken: "page+2/=", maxResults: 5 });
});

test("rejects an ARN selector before contacting AWS", async () => {
  const { client, control, data } = setup();
  await expect(client.listPaymentSessions({ managerId: MANAGER_ARN }, options)).rejects.toThrow(
    "use a payment manager ID, not an ARN",
  );
  expect(control).not.toHaveBeenCalled();
  expect(data).not.toHaveBeenCalled();
});

test.each([
  [{ paymentManagerArn: MANAGER_ARN, authorizerType: "CUSTOM_JWT" }, "CUSTOM_JWT"],
  [{ paymentManagerArn: "", authorizerType: "AWS_IAM" }, "returned no ARN"],
] as const)(
  "rejects an unusable manager before data-plane access: %j",
  async (manager, message) => {
    const { client, controlSend, data } = setup();
    controlSend.mockResolvedValueOnce(manager);
    await expect(client.listPaymentSessions(request, options)).rejects.toThrow(message);
    expect(data).not.toHaveBeenCalled();
  },
);

test("preserves a lookup failure without contacting the data plane", async () => {
  const { client, controlSend, data } = setup();
  const error = new Error("Payment manager not found");
  controlSend.mockRejectedValueOnce(error);
  await expect(client.listPaymentSessions(request, options)).rejects.toBe(error);
  expect(data).not.toHaveBeenCalled();
});

test("preserves a data-plane failure without retrying the lookup", async () => {
  const { client, controlSend, dataSend } = setup();
  const error = new Error("Access denied");
  dataSend.mockRejectedValueOnce(error);
  await expect(client.listPaymentSessions(request, options)).rejects.toBe(error);
  expect(controlSend).toHaveBeenCalledTimes(1);
  expect(dataSend).toHaveBeenCalledTimes(1);
});
