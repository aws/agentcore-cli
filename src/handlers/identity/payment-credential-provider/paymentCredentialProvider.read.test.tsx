import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const BASE = ["identity", "payment-credential-provider"];
const FIXTURE_PROVIDER_NAME = "agentcore-cli-payment-fixture";
const MISSING_PROVIDER_NAME = "agentcore-cli-payment-fixture-2";

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...BASE, ...args, "--region", REGION]);
  return io.stdout();
}

describe("payment-credential-provider read-only command hierarchy", () => {
  test("registers get and list only, with no create, update, or delete commands", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const identity = root.children().find((child) => child.name() === "identity");
    const payment = identity
      ?.children()
      .find((child) => child.name() === "payment-credential-provider");

    expect(payment?.children().map((child) => child.name())).toEqual(["get", "list"]);
  });

  test("prints command help with --json", async () => {
    const stdout = await run(["--json"]);

    expect(stdout).toContain("Usage: agentcore identity payment-credential-provider");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("get");
    expect(stdout).toContain("list");
  });
});

describe("payment-credential-provider get", () => {
  test("prints a recorded provider as JSON", async () => {
    const stdout = await run(["get", "--name", FIXTURE_PROVIDER_NAME]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      name: FIXTURE_PROVIDER_NAME,
      credentialProviderVendor: "CoinbaseCDP",
    });
  });

  test.each([
    ["omitted", ["get"]],
    ["omitted with --json", ["get", "--json"]],
    ["empty", ["get", "--name", ""]],
  ] as const)("requires a nonempty --name when %s", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow("required option '--name <name>' not specified");
  });

  test("preserves the recorded service error name and message", async () => {
    await expect(run(["get", "--name", MISSING_PROVIDER_NAME])).rejects.toMatchObject({
      name: "ResourceNotFoundException",
      message: "PaymentCredentialProvider not found",
    });
  });
});

describe("payment-credential-provider list", () => {
  test.each([
    ["without flags", ["list"]],
    ["with --json", ["list", "--json"]],
  ] as const)("prints recorded providers %s", async (_label, args) => {
    const stdout = await run([...args]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).credentialProviders).toContainEqual(
      expect.objectContaining({ name: FIXTURE_PROVIDER_NAME }),
    );
  });

  test("forwards --max-results and --next-token and preserves pagination tokens", async () => {
    const firstPage = await run(["list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);
    const first = JSON.parse(firstPage);
    expect(first.credentialProviders).toHaveLength(1);
    expect(first.credentialProviders[0].name).toBe("DeployTest-CdpConn-cdp");
    expect(first.nextToken).toBeString();
    expect(first.nextToken.length).toBeGreaterThan(0);

    const secondPage = await run(["list", "--max-results", "1", "--next-token", first.nextToken]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    const second = JSON.parse(secondPage);
    expect(second.credentialProviders).toHaveLength(1);
    expect(second.credentialProviders[0].name).toBe("InvokeMgr-InvokeCdp-cdp");
    expect(second.nextToken).toBeString();
    expect(second.nextToken).not.toBe(first.nextToken);
  });
});

describe("payment-credential-provider read flag validation", () => {
  test.each([
    ["get --name without a value", ["get", "--name"], /--name/],
    ["get with an unknown flag", ["get", "--id", FIXTURE_PROVIDER_NAME], /unknown option '--id'/],
    ["list --max-results without a value", ["list", "--max-results"], /--max-results/],
    ["list --max-results with a non-number", ["list", "--max-results", "abc"], /--max-results/],
    ["list --next-token without a value", ["list", "--next-token"], /--next-token/],
    [
      "list with an unknown flag",
      ["list", "--name", FIXTURE_PROVIDER_NAME],
      /unknown option '--name'/,
    ],
  ] as const)("rejects %s", async (_label, args, message) => {
    await expect(run([...args])).rejects.toThrow(message);
  });
});
