import { describe, expect, test } from "bun:test";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

async function run(args: string[]): Promise<TestCoreClient> {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return core;
}

describe("Gateway update command hierarchy", () => {
  test("registers every update leaf", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const gateway = root.children().find((child) => child.name() === "gateway")!;

    expect(gateway.children().map((child) => child.name())).toContain("update");
    for (const name of ["target", "connector", "rule"]) {
      expect(
        gateway
          .children()
          .find((child) => child.name() === name)!
          .children()
          .map((child) => child.name()),
      ).toContain("update");
    }
  });
});

describe("Gateway update validation", () => {
  test.each([
    ["Gateway selector", ["gateway", "update", "--description", "after"], /--id/],
    ["Gateway mutation", ["gateway", "update", "--id", "gateway-1"], /at least one/],
    [
      "Gateway description conflict",
      ["gateway", "update", "--id", "gateway-1", "--description", "after", "--clear-description"],
      /mutually exclusive/,
    ],
    [
      "Gateway Policy Engine conflict",
      [
        "gateway",
        "update",
        "--id",
        "gateway-1",
        "--clear-policy-engine",
        "--policy-engine-mode",
        "enforce",
      ],
      /conflicts/,
    ],
    ["Target selector", ["gateway", "target", "update", "--name", "after"], /--gateway-id/],
    [
      "Target mutation",
      ["gateway", "target", "update", "--gateway-id", "gateway-1", "--target-id", "target-1"],
      /at least one/,
    ],
    [
      "Target configuration conflict",
      [
        "gateway",
        "target",
        "update",
        "--gateway-id",
        "gateway-1",
        "--target-id",
        "target-1",
        "--endpoint",
        "https://example.test/mcp",
        "--target-configuration",
        "{}",
      ],
      /mutually exclusive/,
    ],
    [
      "Connector selector",
      ["gateway", "connector", "update", "--connector", "web-search"],
      /--gateway-id/,
    ],
    [
      "Connector mutation",
      ["gateway", "connector", "update", "--gateway-id", "gateway-1", "--id", "target-1"],
      /at least one/,
    ],
    ["Rule selector", ["gateway", "rule", "update", "--priority", "20"], /--gateway-id/],
    [
      "Rule mutation",
      ["gateway", "rule", "update", "--gateway-id", "gateway-1", "--rule-id", "rule-1"],
      /at least one/,
    ],
  ] as const)("rejects invalid %s input", async (_name, args, error) => {
    await expect(run([...args])).rejects.toThrow(error);
  });
});

describe("Gateway update patch mapping", () => {
  test("maps Gateway set and clear flags", async () => {
    const core = await run([
      "gateway",
      "update",
      "--id",
      "gateway-1",
      "--description",
      "after",
      "--clear-protocol",
      "--policy-engine-mode",
      "enforce",
      "--clear-exception-level",
    ]);

    expect(core.gateway.calls.find((call) => call.method === "updateGateway")?.args[0]).toEqual({
      id: "gateway-1",
      description: "after",
      clearProtocol: true,
      policyEngineConfiguration: { mode: "ENFORCE" },
      exceptionLevel: null,
    });
  });

  test("maps Target replacement and clear flags", async () => {
    const core = await run([
      "gateway",
      "target",
      "update",
      "--gateway-id",
      "gateway-1",
      "--target-id",
      "target-1",
      "--target-configuration",
      '{"http":{"passthrough":{"endpoint":"https://example.test","protocolType":"CUSTOM"}}}',
      "--clear-description",
      "--clear-credential-provider-configurations",
    ]);

    expect(
      core.gateway.calls.find((call) => call.method === "updateGatewayTarget")?.args[0],
    ).toEqual({
      gatewayId: "gateway-1",
      targetId: "target-1",
      description: null,
      targetConfiguration: {
        http: { passthrough: { endpoint: "https://example.test", protocolType: "CUSTOM" } },
      },
      credentialProviderConfigurations: null,
    });
  });

  test("maps a curated Connector replacement", async () => {
    const core = await run([
      "gateway",
      "connector",
      "update",
      "--gateway-id",
      "gateway-1",
      "--id",
      "target-1",
      "--connector",
      "web-search",
    ]);

    expect(
      core.gateway.calls.find((call) => call.method === "updateGatewayConnector")?.args[0],
    ).toEqual({
      gatewayId: "gateway-1",
      targetId: "target-1",
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            configurations: [
              {
                name: "WebSearch",
                parameterValues: { maxResults: 10 },
              },
            ],
          },
        },
      },
    });
  });

  test("maps Rule PATCH fields", async () => {
    const core = await run([
      "gateway",
      "rule",
      "update",
      "--gateway-id",
      "gateway-1",
      "--rule-id",
      "rule-1",
      "--priority",
      "20",
      "--clear-conditions",
      "--description",
      "after",
    ]);

    expect(core.gateway.calls.find((call) => call.method === "updateGatewayRule")?.args[0]).toEqual(
      {
        gatewayIdentifier: "gateway-1",
        ruleId: "rule-1",
        priority: 20,
        conditions: [],
        description: "after",
      },
    );
  });
});
