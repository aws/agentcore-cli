import { expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import { compile, isTuiCommandSupported, ValueContext } from "../../router";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const CONNECTOR_ID = "agentcorecliconnectore2e-6rodjuiuig";
const INSTRUMENT_CONNECTOR_ID = "mycdpconnectoraidandal-okve8guw4y";
const SESSION_ID = "payment-session-nq812U4e1BJIfw1";
const INSTRUMENT_ID = "payment-instrument-CG2Tl7U1HnCGfHW";
const scope = ["--manager-id", MANAGER_ID, "--user-id", "agentcore-cli-e2e"];

function setup(resource = "manager", overrides: Partial<ReturnType<typeof fixtureFactories>> = {}) {
  const core = new CoreClient({
    ...fixtureFactories(resource === "connector" ? join(FIXTURES, resource) : FIXTURES),
    createDataClient: fixtureFactories(join(FIXTURES, resource)).createDataClient,
    ...overrides,
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
    io,
    root,
    run: (args: string[]) =>
      root.route(["node", "agentcore", "payment", ...args, "--region", "us-west-2"]),
  };
}

test("registers the read-only command tree without TUI or mutation leaves", () => {
  const payment = compile(setup().root, ValueContext.EmptyContext()).commands.find(
    (c) => c.name() === "payment",
  )!;
  expect(
    Object.fromEntries(
      payment.commands.map((resource) => [resource.name(), resource.commands.map((c) => c.name())]),
    ),
  ).toEqual({
    manager: ["get", "list"],
    connector: ["get", "list"],
    session: ["get", "list"],
    instrument: ["get", "list", "balance"],
  });
  for (const resource of payment.commands) {
    for (const command of resource.commands) expect(isTuiCommandSupported(command)).toBe(false);
  }
});

test.each([
  ["manager", "get", ["--id", "mypaymentmanager-o4ks3qfgtb"]],
  ["manager", "list", []],
  ["connector", "get", ["--manager-id", MANAGER_ID, "--connector-id", CONNECTOR_ID]],
  ["connector", "list", ["--manager-id", MANAGER_ID]],
  ["session", "get", [...scope, "--session-id", SESSION_ID]],
  ["session", "list", scope],
  ["instrument", "get", [...scope, "--instrument-id", INSTRUMENT_ID]],
  ["instrument", "list", [...scope, "--connector-id", INSTRUMENT_CONNECTOR_ID]],
] as const)("%s %s renders the recorded response", async (resource, verb, flags) => {
  const { run, io } = setup(resource);
  await run([resource, verb, ...flags]);
  matchGolden(
    resource === "manager" ? FIXTURES : join(FIXTURES, resource),
    `${resource}-${verb}.golden.json`,
    io.stdout(),
  );
});

test.each([
  ["manager", [], {}],
  ["connector", ["--manager-id", MANAGER_ID], { paymentManagerId: MANAGER_ID }],
  ["session", scope, { userId: "agentcore-cli-e2e" }],
  [
    "instrument",
    [...scope, "--connector-id", INSTRUMENT_CONNECTOR_ID],
    { userId: "agentcore-cli-e2e", paymentConnectorId: INSTRUMENT_CONNECTOR_ID },
  ],
] as const)(
  "%s list forwards pagination without consuming further pages",
  async (resource, flags, expected) => {
    const response = { nextToken: "page-3" };
    const send = mock(async (_command: { input: unknown }) => response);
    const isData = resource === "session" || resource === "instrument";
    const { run, io } = setup(resource, {
      [isData ? "createDataClient" : "createControlClient"]: () => ({ send }) as never,
    });
    await run([
      resource,
      "list",
      ...flags,
      "--next-token",
      "page+2/=",
      "--max-results",
      "1",
      "--json",
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toEqual({
      ...expected,
      ...(isData
        ? {
            paymentManagerArn: `arn:aws:bedrock-agentcore:us-west-2:603141041947:payment-manager/${MANAGER_ID}`,
          }
        : {}),
      nextToken: "page+2/=",
      maxResults: 1,
    });
    expect(JSON.parse(io.stdout())).toEqual(response);
  },
);

test("session and instrument reads forward user, agent, and optional connector scope", async () => {
  const { core, run } = setup();
  const session = spyOn(core.payment, "getPaymentSession").mockResolvedValue({
    paymentSession: undefined,
  });
  const instrument = spyOn(core.payment, "getPaymentInstrument").mockResolvedValue({
    paymentInstrument: undefined,
  });
  try {
    await run(["session", "get", ...scope, "--session-id", SESSION_ID, "--agent-name", "agent"]);
    expect(session).toHaveBeenCalledWith(
      {
        managerId: MANAGER_ID,
        userId: "agentcore-cli-e2e",
        paymentSessionId: SESSION_ID,
        agentName: "agent",
      },
      expect.objectContaining({ region: "us-west-2" }),
    );
    await run([
      "instrument",
      "get",
      ...scope,
      "--instrument-id",
      INSTRUMENT_ID,
      "--connector-id",
      INSTRUMENT_CONNECTOR_ID,
    ]);
    expect(instrument).toHaveBeenCalledWith(
      {
        managerId: MANAGER_ID,
        userId: "agentcore-cli-e2e",
        paymentInstrumentId: INSTRUMENT_ID,
        paymentConnectorId: INSTRUMENT_CONNECTOR_ID,
      },
      expect.objectContaining({ region: "us-west-2" }),
    );
  } finally {
    session.mockRestore();
    instrument.mockRestore();
  }
});

test.each([
  [["manager", "get"], "--id"],
  [["connector", "get", "--manager-id", MANAGER_ID], "--connector-id"],
  [["session", "get", ...scope], "--session-id"],
  [["instrument", "get", ...scope], "--instrument-id"],
  [["session", "list", "--manager-id", MANAGER_ID], "--user-id"],
  [
    ["instrument", "get", ...scope, "--instrument-id", INSTRUMENT_ID, "--manager-arn", "arn:old"],
    "unknown option",
  ],
] as const)("rejects incomplete or obsolete selectors: %j", async (args, message) => {
  await expect(setup().run([...args])).rejects.toThrow(message);
});

test.each(["AUTHENTICATION_EXPIRED", "AUTHENTICATION_FAILED"] as const)(
  "connector get reports %s on stderr, except with --json",
  async (status) => {
    const { core, run, io } = setup("connector");
    const call = spyOn(core.payment, "getPaymentConnector").mockResolvedValue({ status } as never);
    try {
      const args = ["connector", "get", "--manager-id", MANAGER_ID, "--connector-id", CONNECTOR_ID];
      await run(args);
      expect(io.stderr()).toContain("cannot be renewed");
      expect(JSON.parse(io.stdout())).toEqual({ status });
      const stderr = io.stderr();
      await run([...args, "--json"]);
      expect(io.stderr()).toBe(stderr);
    } finally {
      call.mockRestore();
    }
  },
);
