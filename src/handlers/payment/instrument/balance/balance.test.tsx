import { expect, mock, test } from "bun:test";
import {
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../../core";
import { createRootHandler } from "../../../index";
import { createSilentLogger, TestGlobalConfigAccessor, testIO } from "../../../../testing";

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:payment-manager/manager";
const scope = ["--manager-id", "manager", "--user-id", "user", "--instrument-id", "instrument"];
// Synthetic response: fixture replay does not require a funded wallet.
const balance = {
  paymentInstrumentId: "instrument",
  tokenBalance: {
    amount: "9007199254740993123456789",
    decimals: 6,
    token: "USDC",
    network: "ETHEREUM",
    chain: "BASE_SEPOLIA",
  },
};

function setup(response: object = balance) {
  const send = mock(async (_command: unknown) => response);
  const unexpectedClient = () => {
    throw new Error("Unexpected AWS client");
  };
  const core = new CoreClient({
    createControlClient: () =>
      ({
        send: async () => ({ paymentManagerArn: ARN, authorizerType: "AWS_IAM" }),
      }) as unknown as BedrockAgentCoreControlClient,
    createDataClient: () => ({ send }) as unknown as BedrockAgentCoreClient,
    createIamClient: unexpectedClient,
    createLogsClient: unexpectedClient,
    logger: createSilentLogger(),
  });
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    send,
    io,
    run: (args: string[]) =>
      root.route([
        "node",
        "agentcore",
        "payment",
        "instrument",
        ...args,
        "--region",
        "us-west-2",
        "--json",
      ]),
  };
}

test("balance sends the selected chain and complete scope, defaults USDC, and preserves atomic precision", async () => {
  const { run, send, io } = setup();
  await run([
    "balance",
    ...scope,
    "--connector-id",
    "connector",
    "--chain",
    "BASE_SEPOLIA",
    "--agent-name",
    "agent",
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetPaymentInstrumentBalanceCommand);
  expect((send.mock.calls[0]![0] as GetPaymentInstrumentBalanceCommand).input).toEqual({
    paymentManagerArn: ARN,
    userId: "user",
    paymentInstrumentId: "instrument",
    paymentConnectorId: "connector",
    chain: "BASE_SEPOLIA",
    token: "USDC",
    agentName: "agent",
  });
  expect(JSON.parse(io.stdout())).toEqual(balance);
});

test("preserves a successful zero balance but never turns an error into zero", async () => {
  const zero = { ...balance, tokenBalance: { ...balance.tokenBalance, amount: "0" } };
  const success = setup(zero);
  const args = ["balance", ...scope, "--connector-id", "connector", "--chain", "BASE"];
  await success.run(args);
  expect(JSON.parse(success.io.stdout())).toEqual(zero);

  const failure = setup();
  const error = new Error("No USDC balance is available");
  failure.send.mockRejectedValueOnce(error);
  await expect(failure.run(args)).rejects.toBe(error);
  expect(failure.io.stdout()).toBe("");
});

test.each([
  [[], "--chain"],
  [["--chain", "base"], "Invalid value for option '--chain'"],
  [["--chain", "BASE", "--token", "ETH"], "Invalid value for option '--token'"],
] as const)("requires an explicit supported chain and token: %j", async (flags, message) => {
  const { run, send } = setup();
  await expect(run(["balance", ...scope, "--connector-id", "connector", ...flags])).rejects.toThrow(
    message,
  );
  expect(send).not.toHaveBeenCalled();
});

test("instrument get remains independent of balance and requires no chain", async () => {
  const response = { paymentInstrument: { paymentInstrumentId: "instrument", status: "ACTIVE" } };
  const { run, send, io } = setup(response);
  await run(["get", ...scope]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetPaymentInstrumentCommand);
  expect(JSON.parse(io.stdout())).toEqual(response);
});
