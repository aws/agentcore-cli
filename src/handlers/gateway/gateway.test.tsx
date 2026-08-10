import { describe, expect, test } from "bun:test";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-1";
const TARGET_ID = "target-1";
const RULE_ID = "rule-1";

async function run(
  args: string[],
  core = new TestCoreClient(),
): Promise<{ core: TestCoreClient; stdout: string }> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout() };
}

describe("gateway command hierarchy", () => {
  test("registers the Gateway command hierarchy", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const gateway = root.children().find((child) => child.name() === "gateway");
    const target = gateway?.children().find((child) => child.name() === "target");
    const connector = gateway?.children().find((child) => child.name() === "connector");
    const rule = gateway?.children().find((child) => child.name() === "rule");

    expect(gateway?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(gateway?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "target",
      "connector",
      "rule",
    ]);
    expect(target?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
    expect(connector?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
    expect(rule?.children().map((child) => child.name())).toEqual(["create", "get", "list"]);
  });

  test.each([
    ["Gateway", ["gateway"]],
    ["Gateway get", ["gateway", "get"]],
    ["Gateway list", ["gateway", "list"]],
    ["Target", ["gateway", "target"]],
    ["Target get", ["gateway", "target", "get"]],
    ["Target list", ["gateway", "target", "list"]],
    ["Connector", ["gateway", "connector"]],
    ["Connector get", ["gateway", "connector", "get"]],
    ["Connector list", ["gateway", "connector", "list"]],
    ["Rule", ["gateway", "rule"]],
    ["Rule get", ["gateway", "rule", "get"]],
    ["Rule list", ["gateway", "rule", "list"]],
  ] as const)("opens the TUI for a bare %s command", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
  });
});

describe("gateway validation", () => {
  test.each([
    ["Gateway get", ["gateway", "get", "--id", ""], /--id/],
    ["Target get parent", ["gateway", "target", "get", "--target-id", TARGET_ID], /--gateway-id/],
    ["Target get child", ["gateway", "target", "get", "--gateway-id", GATEWAY_ID], /--target-id/],
    ["Target list", ["gateway", "target", "list", "--max-results", "1"], /--gateway-id/],
    ["Connector get parent", ["gateway", "connector", "get", "--id", TARGET_ID], /--gateway-id/],
    ["Connector get child", ["gateway", "connector", "get", "--gateway-id", GATEWAY_ID], /--id/],
    ["Connector list", ["gateway", "connector", "list", "--max-results", "1"], /--gateway-id/],
    ["Rule get parent", ["gateway", "rule", "get", "--rule-id", RULE_ID], /--gateway-id/],
    ["Rule get child", ["gateway", "rule", "get", "--gateway-id", GATEWAY_ID], /--rule-id/],
    ["Rule list", ["gateway", "rule", "list", "--max-results", "1"], /--gateway-id/],
  ] as const)(
    "rejects a missing selector for %s before calling Core",
    async (_name, args, error) => {
      const core = new TestCoreClient();

      await expect(run([...args], core)).rejects.toThrow(error);
      expect(core.gateway.calls).toEqual([]);
    },
  );

  test("rejects a non-numeric max-results value before calling Core", async () => {
    const core = new TestCoreClient();

    await expect(run(["gateway", "list", "--max-results", "not-a-number"], core)).rejects.toThrow(
      /Invalid value for option '--max-results'/,
    );
    expect(core.gateway.calls).toEqual([]);
  });
});
