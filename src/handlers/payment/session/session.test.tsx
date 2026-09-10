import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  CreatePaymentSessionCommand,
  type BedrockAgentCoreClient,
  type CreatePaymentSessionRequest,
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
  matchGolden,
  parse,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import sessionCreateFixture from "../__fixtures__/session/CreatePaymentSessionCommand.902bade07933ebb1.json";

// End-to-end command-flow tests for the `payment session` leaves.
//
// Each test builds the real root handler over a real CoreClient whose SDK
// clients are the fixture-backed fakes, then drives it through `route()` exactly
// as the CLI does, so one test covers parsing, middleware, the leaf handler,
// PaymentClient, and the rendered output.
//
// Record with:
//   RECORD=1 AWS_PROFILE=deploy bun test src/handlers/payment/session/session.test.tsx
// The flow uses an AWS_IAM payment manager that already exists in the test
// account (the manager quota is exhausted, so none is created here) and leaves
// nothing behind: it creates one session and deletes it again.

const PAYMENT_FIXTURES = join(import.meta.dir, "..", "__fixtures__");
const FIXTURES = join(PAYMENT_FIXTURES, "session");
// Fixtures are keyed by operation and input, so a `get` issued after the delete
// would overwrite the pre-delete `get` fixture. Reads that expect the session to
// be gone record into their own directory.
const AFTER_DELETE_FIXTURES = join(FIXTURES, "after-delete");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const MANAGER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:603141041947:payment-manager/mypaymentmanageraidandal-gx3nxzaira";
const USER_ID = "agentcore-cli-e2e";
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

function createRoot(core = createFixtureCore()) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return { root, io };
}

async function run(args: string[], fixtures = FIXTURES): Promise<string> {
  const { root, io } = createRoot(createFixtureCore(fixtures));
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

const scoped = ["--manager-id", MANAGER_ID, "--user-id", USER_ID];

describe("payment session command hierarchy", () => {
  test("registers create, get, list, and delete leaves", () => {
    const { root } = createRoot();
    const session = root
      .children()
      .find((child) => child.name() === "payment")
      ?.children()
      .find((child) => child.name() === "session");

    expect(session?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "delete",
    ]);
  });
});

describe("payment session validation", () => {
  test.each(["create", "get", "list", "delete"])(
    "`%s` rejects the removed --manager-arn flag, including alongside --manager-id",
    async (command) => {
      for (const idArgs of [[], scoped]) {
        await expect(
          run(["payment", "session", command, ...idArgs, "--manager-arn", MANAGER_ARN]),
        ).rejects.toThrow(/unknown option '--manager-arn'/);
      }
    },
  );

  test.each(["create", "get", "list", "delete"])(
    "`%s` rejects an explicitly empty --manager-id",
    async (command) => {
      await expect(
        run(["payment", "session", command, "--manager-id", "", "--user-id", USER_ID]),
      ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
    },
  );

  // Every leaf declares its identifying flags optional (so a bare invocation can
  // fall through to the TUI once one exists) but requires them at runtime. None
  // of these reach the SDK, so no fixtures are involved.
  test("`create` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "session", "create", "--user-id", USER_ID, "--expiry-minutes", "15"]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`create` errors when --user-id is omitted", async () => {
    await expect(
      run(["payment", "session", "create", "--manager-id", MANAGER_ID, "--expiry-minutes", "15"]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });

  test("`create` errors when --expiry-minutes is omitted", async () => {
    await expect(run(["payment", "session", "create", ...scoped])).rejects.toThrow(
      /required option '--expiry-minutes <expiry-minutes>' not specified/,
    );
  });

  test("`create` rejects --expiry-minutes below 15", async () => {
    await expect(
      run(["payment", "session", "create", ...scoped, "--expiry-minutes", "14"]),
    ).rejects.toThrow(/Invalid value for option '--expiry-minutes'/);
  });

  test("`create` rejects --expiry-minutes above 480", async () => {
    await expect(
      run(["payment", "session", "create", ...scoped, "--expiry-minutes", "481"]),
    ).rejects.toThrow(/Invalid value for option '--expiry-minutes'/);
  });

  test("`create` rejects a fractional --expiry-minutes", async () => {
    await expect(
      run(["payment", "session", "create", ...scoped, "--expiry-minutes", "15.5"]),
    ).rejects.toThrow(/Invalid value for option '--expiry-minutes'/);
  });

  test("`create` rejects --currency without --max-spend", async () => {
    await expect(
      run([
        "payment",
        "session",
        "create",
        ...scoped,
        "--expiry-minutes",
        "15",
        "--currency",
        "USD",
      ]),
    ).rejects.toThrow(/--currency requires --max-spend/);
  });

  test.each(["", " \t\n "])(
    "`create` rejects blank --max-spend %j before calling Core",
    async (maxSpend) => {
      const core = createFixtureCore();
      const createSession = spyOn(core.payment, "createPaymentSession").mockRejectedValue(
        new Error("unexpected session creation during validation"),
      );
      try {
        for (const currencyArgs of [[], ["--currency", "USD"]]) {
          const { root } = createRoot(core);
          await expect(
            root.route([
              "node",
              "agentcore",
              "payment",
              "session",
              "create",
              ...scoped,
              "--expiry-minutes",
              "15",
              "--max-spend",
              maxSpend,
              ...currencyArgs,
              "--region",
              REGION,
            ]),
          ).rejects.toThrow("--max-spend must not be empty or whitespace");
          expect(createSession).not.toHaveBeenCalled();
        }
      } finally {
        createSession.mockRestore();
      }
    },
  );

  test.each([
    { label: "omitted", args: [], limits: undefined },
    {
      label: "zero",
      args: ["--max-spend", "0"],
      limits: { maxSpendAmount: { value: "0", currency: "USD" } },
    },
    {
      label: "exact decimal text",
      args: ["--max-spend", "10.00"],
      limits: { maxSpendAmount: { value: "10.00", currency: "USD" } },
    },
  ])("`create` preserves $label --max-spend in the SDK request", async ({ args, limits }) => {
    const requests: CreatePaymentSessionRequest[] = [];
    const lookups: GetPaymentManagerCommand[] = [];
    const core = new CoreClient({
      ...fixtureFactories(PAYMENT_FIXTURES),
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
          send: async (command: CreatePaymentSessionCommand) => {
            expect(command).toBeInstanceOf(CreatePaymentSessionCommand);
            requests.push(command.input);
            return parse(JSON.stringify(sessionCreateFixture));
          },
        }) as unknown as BedrockAgentCoreClient,
      logger: createSilentLogger(),
    });
    const { root, io } = createRoot(core);
    await root.route([
      "node",
      "agentcore",
      "payment",
      "session",
      "create",
      ...scoped,
      "--expiry-minutes",
      "15",
      ...args,
      "--region",
      REGION,
    ]);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.input).toEqual({ paymentManagerId: MANAGER_ID });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.paymentManagerArn).toBe(MANAGER_ARN);
    expect(requests[0]).not.toHaveProperty("managerId");
    expect(requests[0]?.limits).toEqual(limits);
    expect(JSON.parse(io.stdout()).paymentSession.paymentSessionId).toBe(
      sessionCreateFixture.paymentSession.paymentSessionId,
    );
  });

  test("`create` rejects an unsupported --currency", async () => {
    await expect(
      run([
        "payment",
        "session",
        "create",
        ...scoped,
        "--expiry-minutes",
        "15",
        "--max-spend",
        "1.00",
        "--currency",
        "EUR",
      ]),
    ).rejects.toThrow(/Invalid value for option '--currency'/);
  });

  test("`get` errors when --session-id is omitted", async () => {
    await expect(run(["payment", "session", "get", ...scoped])).rejects.toThrow(
      /required option '--session-id <session-id>' not specified/,
    );
  });

  test("`get` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "session", "get", "--user-id", USER_ID, "--session-id", "s-1"]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`get` errors when --user-id is omitted", async () => {
    await expect(
      run(["payment", "session", "get", "--manager-id", MANAGER_ID, "--session-id", "s-1"]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });

  test("`list` errors when --manager-id is omitted", async () => {
    await expect(run(["payment", "session", "list", "--user-id", USER_ID])).rejects.toThrow(
      /required option '--manager-id <manager-id>' not specified/,
    );
  });

  test("`list` errors when --user-id is omitted", async () => {
    await expect(run(["payment", "session", "list", "--manager-id", MANAGER_ID])).rejects.toThrow(
      /required option '--user-id <user-id>' not specified/,
    );
  });

  test("`delete` errors when --session-id is omitted", async () => {
    await expect(run(["payment", "session", "delete", ...scoped])).rejects.toThrow(
      /required option '--session-id <session-id>' not specified/,
    );
  });

  test("`delete` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "session", "delete", "--user-id", USER_ID, "--session-id", "s-1"]),
    ).rejects.toThrow(/required option '--manager-id <manager-id>' not specified/);
  });

  test("`delete` errors when --user-id is omitted", async () => {
    await expect(
      run(["payment", "session", "delete", "--manager-id", MANAGER_ID, "--session-id", "s-1"]),
    ).rejects.toThrow(/required option '--user-id <user-id>' not specified/);
  });
});

// ─── session flow (create → get → list → delete → get) ───────────────────────
//
// Drives the lifecycle of a real payment session, in order, through route().
// In record mode it hits the live data plane and persists every exchange;
// replays are offline and instant. Later tests consume the id parsed from
// earlier output.

const state: { sessionId?: string } = {};

describe("payment session flow", () => {
  test(
    "`create` opens a session with a spend limit",
    async () => {
      const out = await run([
        "payment",
        "session",
        "create",
        ...scoped,
        "--expiry-minutes",
        "15",
        "--max-spend",
        "1.00",
        "--currency",
        "USD",
      ]);
      matchGolden(FIXTURES, "session-create.golden.json", out);

      const { paymentSession } = JSON.parse(out);
      expect(paymentSession.paymentSessionId).toBeDefined();
      expect(paymentSession.paymentManagerArn).toBe(MANAGER_ARN);
      expect(paymentSession.userId).toBe(USER_ID);
      expect(paymentSession.expiryTimeInMinutes).toBe(15);
      expect(paymentSession.limits.maxSpendAmount.currency).toBe("USD");
      expect(Number(paymentSession.limits.maxSpendAmount.value)).toBe(1);
      state.sessionId = paymentSession.paymentSessionId;
    },
    FLOW_TIMEOUT,
  );

  test(
    "`get` returns the session",
    async () => {
      const out = await run([
        "payment",
        "session",
        "get",
        ...scoped,
        "--session-id",
        state.sessionId!,
      ]);
      matchGolden(FIXTURES, "session-get.golden.json", out);
      expect(JSON.parse(out).paymentSession.paymentSessionId).toBe(state.sessionId);
    },
    FLOW_TIMEOUT,
  );

  test(
    "`list` includes the session",
    async () => {
      const out = await run(["payment", "session", "list", ...scoped]);
      matchGolden(FIXTURES, "session-list.golden.json", out);

      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed.paymentSessions)).toBe(true);
      expect(
        parsed.paymentSessions.map(
          (session: { paymentSessionId: string }) => session.paymentSessionId,
        ),
      ).toContain(state.sessionId);
    },
    FLOW_TIMEOUT,
  );

  test(
    "`delete` deletes the session",
    async () => {
      const out = await run([
        "payment",
        "session",
        "delete",
        ...scoped,
        "--session-id",
        state.sessionId!,
      ]);
      matchGolden(FIXTURES, "session-delete.golden.json", out);
      expect(JSON.parse(out).status).toBe("DELETED");
    },
    FLOW_TIMEOUT,
  );

  test(
    "`get` after delete reports the session missing",
    async () => {
      await expect(
        run(
          ["payment", "session", "get", ...scoped, "--session-id", state.sessionId!],
          AFTER_DELETE_FIXTURES,
        ),
      ).rejects.toThrow(/ResourceNotFound|not found/i);
    },
    FLOW_TIMEOUT,
  );
});
