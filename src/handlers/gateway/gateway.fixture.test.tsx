import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const CONNECTOR_REGION = "us-east-1";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const GATEWAY_ID = "agentcore-cli-gateway-read-fixture-a-l6opkbe2kd";
const TARGET_ID = "KALJACI9HO";
const RULE_GATEWAY_ID = "agentcore-cli-gateway-read-rule-fixture-lhpid2reoy";
const RULE_ID = "d396c3f4-4591-41b3-a4d5-816e03c32419";
const CONNECTOR_GATEWAY_ID = "agentcore-cli-gateway-read-connector-gkzcxxkc5e";
const CONNECTOR_ID = "Z3FQ0H8JCK";

// Account 685197708687 owns the persistent read-only fixture graph:
// listable Gateways and Targets in REGION, plus one READY connector Target under
// CONNECTOR_GATEWAY_ID in CONNECTOR_REGION. Record with:
// AWS_PROFILE=e2e-test RECORD=1 bun test src/handlers/gateway/gateway.fixture.test.tsx
function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[], region = REGION): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", region]);
  return io.stdout();
}

describe("Gateway fixture-backed reads", () => {
  test("gets a Gateway", async () => {
    const stdout = await run(["gateway", "get", "--id", GATEWAY_ID]);
    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).gatewayId).toBe(GATEWAY_ID);
  });

  test("paginates Gateways", async () => {
    const page1 = await run(["gateway", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", page1);
    const first = JSON.parse(page1);
    expect(first.items).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const page2 = await run([
      "gateway",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", page2);
    expect(JSON.parse(page2).items).toHaveLength(1);
  });

  test("gets a Gateway Target", async () => {
    const stdout = await run([
      "gateway",
      "target",
      "get",
      "--gateway-id",
      GATEWAY_ID,
      "--target-id",
      TARGET_ID,
    ]);
    matchGolden(FIXTURES, "target-get.golden.json", stdout);
    expect(JSON.parse(stdout).targetId).toBe(TARGET_ID);
  });

  test("paginates Gateway Targets", async () => {
    const page1 = await run([
      "gateway",
      "target",
      "list",
      "--gateway-id",
      GATEWAY_ID,
      "--max-results",
      "1",
    ]);
    matchGolden(FIXTURES, "target-list-page-1.golden.json", page1);
    const first = JSON.parse(page1);
    expect(first.items).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const page2 = await run([
      "gateway",
      "target",
      "list",
      "--gateway-id",
      GATEWAY_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "target-list-page-2.golden.json", page2);
    expect(JSON.parse(page2).items).toHaveLength(1);
  });

  test("gets a Gateway Connector", async () => {
    const stdout = await run(
      ["gateway", "connector", "get", "--gateway-id", CONNECTOR_GATEWAY_ID, "--id", CONNECTOR_ID],
      CONNECTOR_REGION,
    );
    matchGolden(FIXTURES, "connector-get.golden.json", stdout);
    expect(JSON.parse(stdout).targetId).toBe(CONNECTOR_ID);
  });

  test("lists Gateway Connectors", async () => {
    const stdout = await run(
      ["gateway", "connector", "list", "--gateway-id", CONNECTOR_GATEWAY_ID],
      CONNECTOR_REGION,
    );
    matchGolden(FIXTURES, "connector-list.golden.json", stdout);
    expect(JSON.parse(stdout).items.map(({ targetId }: { targetId: string }) => targetId)).toEqual([
      CONNECTOR_ID,
    ]);
  });

  test("gets a Gateway Rule", async () => {
    const stdout = await run([
      "gateway",
      "rule",
      "get",
      "--gateway-id",
      RULE_GATEWAY_ID,
      "--rule-id",
      RULE_ID,
    ]);
    matchGolden(FIXTURES, "rule-get.golden.json", stdout);
    expect(JSON.parse(stdout).ruleId).toBe(RULE_ID);
  });

  test("paginates Gateway Rules", async () => {
    const page1 = await run([
      "gateway",
      "rule",
      "list",
      "--gateway-id",
      RULE_GATEWAY_ID,
      "--max-results",
      "1",
    ]);
    matchGolden(FIXTURES, "rule-list-page-1.golden.json", page1);
    const first = JSON.parse(page1);
    expect(first.gatewayRules).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const page2 = await run([
      "gateway",
      "rule",
      "list",
      "--gateway-id",
      RULE_GATEWAY_ID,
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "rule-list-page-2.golden.json", page2);
    expect(JSON.parse(page2).gatewayRules).toHaveLength(1);
  });

  test.each([
    ["Gateway", ["gateway", "get", "--id", "missing-gateway-0000000000"]],
    [
      "Target",
      ["gateway", "target", "get", "--gateway-id", GATEWAY_ID, "--target-id", "MISSING000"],
    ],
    [
      "Rule",
      [
        "gateway",
        "rule",
        "get",
        "--gateway-id",
        RULE_GATEWAY_ID,
        "--rule-id",
        "00000000-0000-4000-8000-000000000000",
      ],
    ],
  ] as const)("propagates recorded not-found errors for %s", async (_label, args) => {
    await expect(run([...args])).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});
