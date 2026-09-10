import { describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  AccessDeniedException,
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
  ListPaymentManagersCommand,
  ResourceNotFoundException,
  type BedrockAgentCoreControlClient,
  type GetPaymentConnectorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient, type ClientConfig } from "../../core";
import { compile, isTuiCommandSupported, ValueContext } from "../../router";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  parse,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";
import connectorFixture from "./__fixtures__/connector/GetPaymentConnectorCommand.9f8dfd59b8af870.json";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const REGION = "us-west-2";
const EXISTING_MANAGER_ID = "mypaymentmanager-o4ks3qfgtb";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const MANAGER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:603141041947:payment-manager/mypaymentmanageraidandal-gx3nxzaira";
const CONNECTOR_ID = "agentcorecliconnectore2e-6rodjuiuig";
const INSTRUMENT_CONNECTOR_ID = "mycdpconnectoraidandal-okve8guw4y";
const SESSION_ID = "payment-session-nq812U4e1BJIfw1";
const INSTRUMENT_ID = "payment-instrument-CG2Tl7U1HnCGfHW";
const USER_ID = "agentcore-cli-e2e";
const scoped = [
  ["--manager-id", MANAGER_ID],
  ["--user-id", USER_ID],
];

type Resource = "manager" | "connector" | "session" | "instrument";
type Send = (command: { input: unknown }) => Promise<unknown>;

function createCommandTest({
  resource = "manager",
  controlSend,
  dataSend,
}: {
  resource?: Resource;
  controlSend?: Send;
  dataSend?: Send;
} = {}) {
  const factories = fixtureFactories(
    resource === "connector" ? join(FIXTURES, "connector") : FIXTURES,
  );
  const dataFactories = fixtureFactories(join(FIXTURES, resource));
  const createControlClient = mock((config: ClientConfig) =>
    controlSend
      ? ({ send: controlSend } as unknown as BedrockAgentCoreControlClient)
      : factories.createControlClient(config),
  );
  const createDataClient = mock((config: ClientConfig) =>
    dataSend
      ? ({ send: dataSend } as unknown as BedrockAgentCoreClient)
      : dataFactories.createDataClient(config),
  );
  const unexpectedClient = () => {
    throw new Error("payment reads must not use other SDK clients");
  };
  const core = new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient: unexpectedClient,
    createLogsClient: unexpectedClient,
    createCloudFormationClient: unexpectedClient,
    logger: createSilentLogger(),
  });
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    root,
    io,
    createControlClient,
    createDataClient,
    run: (args: string[], region = REGION) =>
      root.route(["node", "agentcore", "payment", ...args, "--region", region]),
  };
}

const reads = [
  {
    resource: "manager",
    verb: "get",
    requiredFlags: [["--id", EXISTING_MANAGER_ID]],
    expected: { paymentManagerId: EXISTING_MANAGER_ID, status: "READY" },
  },
  {
    resource: "manager",
    verb: "list",
    requiredFlags: [],
    expected: {
      paymentManagers: expect.arrayContaining([
        expect.objectContaining({ paymentManagerId: EXISTING_MANAGER_ID }),
      ]),
    },
  },
  {
    resource: "connector",
    verb: "get",
    requiredFlags: [
      ["--manager-id", MANAGER_ID],
      ["--connector-id", CONNECTOR_ID],
    ],
    expected: { paymentConnectorId: CONNECTOR_ID, status: "READY" },
  },
  {
    resource: "connector",
    verb: "list",
    requiredFlags: [["--manager-id", MANAGER_ID]],
    expected: {
      paymentConnectors: expect.arrayContaining([
        expect.objectContaining({ paymentConnectorId: CONNECTOR_ID }),
      ]),
    },
  },
  {
    resource: "session",
    verb: "get",
    requiredFlags: [...scoped, ["--session-id", SESSION_ID]],
    expected: { paymentSession: { paymentSessionId: SESSION_ID, userId: USER_ID } },
  },
  {
    resource: "session",
    verb: "list",
    requiredFlags: scoped,
    expected: {
      paymentSessions: expect.arrayContaining([
        expect.objectContaining({ paymentSessionId: SESSION_ID }),
      ]),
    },
  },
  {
    resource: "instrument",
    verb: "get",
    requiredFlags: [...scoped, ["--instrument-id", INSTRUMENT_ID]],
    expected: {
      paymentInstrument: { paymentInstrumentId: INSTRUMENT_ID, status: "ACTIVE" },
    },
  },
  {
    resource: "instrument",
    verb: "list",
    requiredFlags: scoped,
    expected: {
      paymentInstruments: expect.arrayContaining([
        expect.objectContaining({ paymentInstrumentId: INSTRUMENT_ID }),
      ]),
    },
  },
] satisfies {
  resource: Resource;
  verb: string;
  requiredFlags: string[][];
  expected: object;
}[];

describe("payment read-only command tree", () => {
  test("exposes exactly nine CLI-only leaves and no write commands", () => {
    const { root } = createCommandTest();
    const payment = compile(root, ValueContext.EmptyContext()).commands.find(
      (command) => command.name() === "payment",
    );
    expect(payment).toBeDefined();
    expect(isTuiCommandSupported(payment!)).toBe(false);
    expect(
      Object.fromEntries(
        payment!.commands.map((resource) => [
          resource.name(),
          resource.commands.map((command) => command.name()),
        ]),
      ),
    ).toEqual({
      manager: ["get", "list"],
      connector: ["get", "list"],
      session: ["get", "list"],
      instrument: ["get", "list", "balance"],
    });
    const leaves = payment!.commands.flatMap((resource) => resource.commands);
    expect(leaves).toHaveLength(9);
    for (const command of [...payment!.commands, ...leaves]) {
      expect(isTuiCommandSupported(command)).toBe(false);
      expect(command.options.map((option) => option.long)).not.toContain("--wait");
      expect(command.options.map((option) => option.long)).not.toContain("--browser");
    }
  });
});

for (const { resource, verb, requiredFlags, expected } of reads) {
  describe(`payment ${resource} ${verb} read`, () => {
    test("replays an independent Get/List fixture through the real root and Core", async () => {
      const { run, io } = createCommandTest({ resource });
      const filter =
        resource === "instrument" && verb === "list"
          ? ["--connector-id", INSTRUMENT_CONNECTOR_ID]
          : [];
      await run([resource, verb, ...requiredFlags.flat(), ...filter, "--json"]);

      matchGolden(
        resource === "manager" ? FIXTURES : join(FIXTURES, resource),
        `${resource}-${verb}.golden.json`,
        io.stdout(),
      );
      expect(JSON.parse(io.stdout())).toMatchObject(expected);
      expect(io.stderr()).toBe("");
    });

    for (const [flagName] of requiredFlags) {
      test.each(["omitted", "empty"])(
        `rejects %s ${flagName} before constructing SDK clients`,
        async (mode) => {
          const { run, io, createControlClient, createDataClient } = createCommandTest({
            resource,
          });
          const flags = requiredFlags.flatMap(([name, value]) =>
            name !== flagName ? [name!, value!] : mode === "empty" ? [name!, ""] : [],
          );
          await expect(run([resource, verb, ...flags])).rejects.toThrow(
            `required option '${flagName} <${flagName!.slice(2)}>' not specified`,
          );
          expect(createControlClient).not.toHaveBeenCalled();
          expect(createDataClient).not.toHaveBeenCalled();
          expect(io.stdout()).toBe("");
          expect(io.stderr()).toBe("");
        },
      );
    }

    test.each([
      new ResourceNotFoundException({ message: "Payment resource not found", $metadata: {} }),
      new AccessDeniedException({ message: "Access to payment resource denied", $metadata: {} }),
    ])("propagates $name unchanged without rendering output", async (error) => {
      const send = mock(async () => {
        throw error;
      });
      const isData = resource === "session" || resource === "instrument";
      const { run, io } = createCommandTest({
        resource,
        ...(isData ? { dataSend: send } : { controlSend: send }),
      });
      await expect(run([resource, verb, ...requiredFlags.flat(), "--json"])).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe("");
    });
  });
}

const lists = [
  {
    resource: "manager",
    flags: [],
    command: ListPaymentManagersCommand,
    request: {},
    field: "paymentManagers",
    item: { paymentManagerId: EXISTING_MANAGER_ID },
  },
  {
    resource: "connector",
    flags: ["--manager-id", MANAGER_ID],
    command: ListPaymentConnectorsCommand,
    request: { paymentManagerId: MANAGER_ID },
    field: "paymentConnectors",
    item: { paymentConnectorId: CONNECTOR_ID },
  },
  {
    resource: "session",
    flags: scoped.flat(),
    command: ListPaymentSessionsCommand,
    request: { paymentManagerArn: MANAGER_ARN, userId: USER_ID },
    field: "paymentSessions",
    item: { paymentSessionId: SESSION_ID },
  },
  {
    resource: "instrument",
    flags: [...scoped.flat(), "--connector-id", INSTRUMENT_CONNECTOR_ID],
    command: ListPaymentInstrumentsCommand,
    request: {
      paymentManagerArn: MANAGER_ARN,
      userId: USER_ID,
      paymentConnectorId: INSTRUMENT_CONNECTOR_ID,
    },
    field: "paymentInstruments",
    item: { paymentInstrumentId: INSTRUMENT_ID },
  },
] satisfies {
  resource: Resource;
  flags: string[];
  command: unknown;
  request: object;
  field: string;
  item: object;
}[];

describe("payment read pagination", () => {
  test.each(lists)(
    "$resource list preserves page size, opaque tokens, and an empty last page",
    async ({ resource, flags, command: Command, request, field, item }) => {
      const nextToken = "page+2/=opaque";
      const send = mock(async (command: { input: unknown }) => {
        expect(command).toBeInstanceOf(Command);
        return (command.input as { nextToken?: string }).nextToken
          ? { [field]: [] }
          : { [field]: [item], nextToken };
      });
      const isData = resource === "session" || resource === "instrument";
      const options = { resource, ...(isData ? { dataSend: send } : { controlSend: send }) };
      const first = createCommandTest(options);
      await first.run([resource, "list", ...flags, "--max-results", "1", "--json"]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0].input).toEqual({
        ...request,
        maxResults: 1,
        ...(isData ? {} : { nextToken: undefined }),
      });
      const page = JSON.parse(first.io.stdout());
      expect(page).toEqual({ [field]: [item], nextToken });

      const second = createCommandTest(options);
      await second.run([
        resource,
        "list",
        ...flags,
        "--max-results",
        "1",
        "--next-token",
        page.nextToken,
        "--json",
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0].input).toEqual({ ...request, maxResults: 1, nextToken });
      expect(JSON.parse(second.io.stdout())).toEqual({ [field]: [] });
    },
  );

  test.each(lists)(
    "$resource list rejects a non-numeric page size before constructing SDK clients",
    async ({ resource, flags }) => {
      const { run, createControlClient, createDataClient } = createCommandTest({ resource });
      await expect(
        run([resource, "list", ...flags, "--max-results", "not-a-number"]),
      ).rejects.toThrow("Invalid value for option '--max-results'");
      expect(createControlClient).not.toHaveBeenCalled();
      expect(createDataClient).not.toHaveBeenCalled();
    },
  );
});

const dataReads = [
  {
    resource: "session",
    verb: "get",
    method: "getPaymentSession",
    command: GetPaymentSessionCommand,
    flags: ["--session-id", SESSION_ID],
    request: { paymentSessionId: SESSION_ID },
  },
  {
    resource: "session",
    verb: "list",
    method: "listPaymentSessions",
    command: ListPaymentSessionsCommand,
    flags: [],
    request: {},
  },
  {
    resource: "instrument",
    verb: "get",
    method: "getPaymentInstrument",
    command: GetPaymentInstrumentCommand,
    flags: ["--instrument-id", INSTRUMENT_ID, "--connector-id", INSTRUMENT_CONNECTOR_ID],
    request: { paymentInstrumentId: INSTRUMENT_ID, paymentConnectorId: INSTRUMENT_CONNECTOR_ID },
  },
  {
    resource: "instrument",
    verb: "list",
    method: "listPaymentInstruments",
    command: ListPaymentInstrumentsCommand,
    flags: ["--connector-id", INSTRUMENT_CONNECTOR_ID],
    request: { paymentConnectorId: INSTRUMENT_CONNECTOR_ID },
  },
] as const;

for (const { resource, verb, method, command: Command, flags, request } of dataReads) {
  describe(`payment ${resource} ${verb} scope`, () => {
    test("passes managerId to Core and uses the configured region for both SDK clients", async () => {
      const controlSend = mock(async (command: { input: unknown }) => {
        expect(command).toBeInstanceOf(GetPaymentManagerCommand);
        expect(command.input).toEqual({ paymentManagerId: MANAGER_ID });
        return { paymentManagerArn: MANAGER_ARN, authorizerType: "AWS_IAM" };
      });
      const dataSend = mock(async (command: { input: unknown }) => {
        expect(command).toBeInstanceOf(Command);
        expect(command.input).toEqual({
          ...request,
          paymentManagerArn: MANAGER_ARN,
          userId: USER_ID,
          agentName: "read-agent",
        });
        return {};
      });
      const { core, run, createControlClient, createDataClient } = createCommandTest({
        resource,
        controlSend,
        dataSend,
      });
      const call = spyOn(core.payment, method);
      try {
        await run(
          [
            resource,
            verb,
            ...scoped.flat(),
            ...flags,
            "--agent-name",
            "read-agent",
            "--endpoint-url",
            "https://payments.example.test",
          ],
          "eu-west-1",
        );
        expect(call).toHaveBeenCalledWith(
          { ...request, managerId: MANAGER_ID, userId: USER_ID, agentName: "read-agent" },
          expect.objectContaining({
            region: "eu-west-1",
            endpointUrl: "https://payments.example.test",
          }),
        );
      } finally {
        call.mockRestore();
      }
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(dataSend).toHaveBeenCalledTimes(1);
      for (const factory of [createControlClient, createDataClient]) {
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith({
          region: "eu-west-1",
          endpoint: "https://payments.example.test",
        });
      }
    });

    test("rejects ARN selectors and the removed --manager-arn flag before SDK calls", async () => {
      const { run, createControlClient, createDataClient } = createCommandTest({ resource });
      await expect(
        run([resource, verb, "--manager-id", MANAGER_ARN, "--user-id", USER_ID, ...flags]),
      ).rejects.toThrow("use a payment manager ID, not an ARN");
      for (const idArgs of [[], scoped.flat()]) {
        await expect(
          run([resource, verb, ...idArgs, ...flags, "--manager-arn", MANAGER_ARN]),
        ).rejects.toThrow("unknown option '--manager-arn'");
      }
      expect(createControlClient).not.toHaveBeenCalled();
      expect(createDataClient).not.toHaveBeenCalled();
    });

    test("preserves a parent lookup error without calling the data plane", async () => {
      const error = new ResourceNotFoundException({
        message: "Payment manager not found",
        $metadata: {},
      });
      const controlSend = mock(async () => {
        throw error;
      });
      const { run, io, createDataClient } = createCommandTest({ resource, controlSend });
      await expect(run([resource, verb, ...scoped.flat(), ...flags])).rejects.toBe(error);
      expect(controlSend).toHaveBeenCalledTimes(1);
      expect(createDataClient).not.toHaveBeenCalled();
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe("");
    });

    test.each([
      {
        manager: { paymentManagerArn: MANAGER_ARN, authorizerType: "CUSTOM_JWT" },
        message: "uses the CUSTOM_JWT authorizer",
      },
      { manager: { authorizerType: "AWS_IAM" }, message: "returned no ARN" },
    ])("rejects an unusable manager: $message", async ({ manager, message }) => {
      const { run, io, createDataClient } = createCommandTest({
        resource,
        controlSend: async () => manager,
      });
      await expect(run([resource, verb, ...scoped.flat(), ...flags])).rejects.toThrow(message);
      expect(createDataClient).not.toHaveBeenCalled();
      expect(io.stdout()).toBe("");
    });
  });
}

describe("payment connector read-only hints", () => {
  test.each([
    "AUTHENTICATION_EXPIRED",
    "AUTHENTICATION_FAILED",
    "PENDING_AUTHENTICATION",
    "READY",
  ] as const)("preserves %s without suggesting absent write commands", async (status) => {
    for (const jsonFlags of [[], ["--json"]]) {
      const response = {
        ...parse<GetPaymentConnectorResponse>(JSON.stringify(connectorFixture)),
        status,
      };
      const send = mock(async (command: { input: unknown }) => {
        expect(command).toBeInstanceOf(GetPaymentConnectorCommand);
        expect(command.input).toEqual({
          paymentManagerId: MANAGER_ID,
          paymentConnectorId: CONNECTOR_ID,
        });
        return response;
      });
      const { run, io } = createCommandTest({ resource: "connector", controlSend: send });
      await run([
        "connector",
        "get",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        CONNECTOR_ID,
        ...jsonFlags,
      ]);
      expect(JSON.parse(io.stdout())).toEqual(JSON.parse(JSON.stringify(response)));
      expect(send).toHaveBeenCalledTimes(1);
      const terminal = status === "AUTHENTICATION_EXPIRED" || status === "AUTHENTICATION_FAILED";
      if (terminal && jsonFlags.length === 0) {
        expect(io.stderr()).toContain(status);
        expect(io.stderr()).toContain("cannot be renewed");
        expect(io.stderr()).not.toMatch(/create|delete|update|--quick-create|browser|wait/i);
      } else {
        expect(io.stderr()).toBe("");
      }
    }
  });
});
