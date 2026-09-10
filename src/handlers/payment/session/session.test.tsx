import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
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

const PAYMENT_FIXTURES = join(import.meta.dir, "..", "__fixtures__");
const FIXTURES = join(PAYMENT_FIXTURES, "session");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const USER_ID = "agentcore-cli-e2e";
const scoped = ["--manager-id", MANAGER_ID, "--user-id", USER_ID];
const createArgs = ["create", ...scoped, "--expiry-minutes", "15"];

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  return new CoreClient({
    ...fixtureFactories(PAYMENT_FIXTURES),
    createDataClient: fixtureFactories(fixtures).createDataClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[], core = createFixtureCore()): Promise<string> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "payment", "session", ...args, "--region", REGION]);
  return io.stdout();
}

describe("payment session create", () => {
  test.each(["14", "481", "15.5"])(
    "rejects expiry outside whole minutes 15..480: %s",
    async (value) => {
      await expect(run(["create", ...scoped, "--expiry-minutes", value])).rejects.toThrow(
        "Invalid value for option '--expiry-minutes'",
      );
    },
  );

  test.each([
    { args: ["--currency", "USD"], error: "--currency requires --max-spend" },
    { args: ["--max-spend", ""], error: "--max-spend must not be empty or whitespace" },
    {
      args: ["--max-spend", " \t\n ", "--currency", "USD"],
      error: "--max-spend must not be empty or whitespace",
    },
    {
      args: ["--max-spend", "1.00", "--currency", "EUR"],
      error: "Invalid value for option '--currency'",
    },
  ])("rejects invalid spend flags $args before Core", async ({ args, error }) => {
    const core = createFixtureCore();
    const create = spyOn(core.payment, "createPaymentSession");
    await expect(run([...createArgs, ...args], core)).rejects.toThrow(error);
    expect(create).not.toHaveBeenCalled();
  });

  test.each([undefined, "0", "10.00"])(
    "preserves spend %j without numeric coercion",
    async (value) => {
      const data = fixtureFactories(FIXTURES).createDataClient({ region: REGION });
      const send = spyOn(data, "send").mockResolvedValue(
        parse(JSON.stringify(sessionCreateFixture)),
      );
      const core = new CoreClient({
        ...fixtureFactories(PAYMENT_FIXTURES),
        createDataClient: () => data,
        logger: createSilentLogger(),
      });

      await run([...createArgs, ...(value === undefined ? [] : ["--max-spend", value])], core);

      expect(send).toHaveBeenCalledTimes(1);
      const request = send.mock.calls[0]![0].input;
      if (value === undefined) {
        expect(request).not.toHaveProperty("limits");
      } else {
        expect(request).toHaveProperty("limits", {
          maxSpendAmount: { value, currency: "USD" },
        });
      }
    },
  );
});

test("payment session lifecycle replays create, read-back, and delete through root/Core", async () => {
  const created = await run([...createArgs, "--max-spend", "1.00", "--currency", "USD"]);
  matchGolden(FIXTURES, "session-create.golden.json", created);
  const { paymentSession } = JSON.parse(created);
  expect(paymentSession.expiryTimeInMinutes).toBe(15);
  expect(paymentSession.limits.maxSpendAmount.currency).toBe("USD");
  expect(Number(paymentSession.limits.maxSpendAmount.value)).toBe(1);

  const sessionArgs = [...scoped, "--session-id", paymentSession.paymentSessionId];
  const detail = await run(["get", ...sessionArgs]);
  matchGolden(FIXTURES, "session-get.golden.json", detail);
  expect(JSON.parse(detail).paymentSession.paymentSessionId).toBe(paymentSession.paymentSessionId);

  const deleted = await run(["delete", ...sessionArgs]);
  matchGolden(FIXTURES, "session-delete.golden.json", deleted);
  expect(JSON.parse(deleted).status).toBe("DELETED");

  // The same Get request has a separate post-delete fixture.
  await expect(
    run(["get", ...sessionArgs], createFixtureCore(join(FIXTURES, "after-delete"))),
  ).rejects.toThrow(/ResourceNotFound|not found/i);
});
