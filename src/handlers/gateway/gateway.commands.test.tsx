import { describe, expect, test } from "bun:test";
import { compile, ValueContext } from "../../router";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

// Gateways and their Targets, connectors, and Rules are created, changed, and
// deleted through AgentCore projects, so the standalone group only reads and
// invokes them.
const REMOVED = ["", "target ", "connector ", "rule "].flatMap((group) =>
  ["create", "update", "delete"].map((mutation) => `gateway ${group}${mutation}`),
);

function setup() {
  const core = new TestCoreClient();
  const root = createRootHandler(core, {
    io: testIO().io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  const command = compile(root, ValueContext.EmptyContext());
  command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return { core, command };
}

describe("Gateway command availability", () => {
  test("constructs the tree from the startup snapshot without rereading config", () => {
    let reads = 0;
    const globalConfigAccessor = new TestGlobalConfigAccessor();
    globalConfigAccessor.get = async () => {
      reads++;
      throw new Error("Router construction must not read config");
    };
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor,
    });
    expect(root.children().map((child) => child.name())).toContain("gateway");
    expect(reads).toBe(0);
  });

  test("builds the Gateway group", () => {
    const { command } = setup();
    const gateway = command.commands.find((child) => child.name() === "gateway")!;
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toContain("gateway");
    expect(gateway.commands.map((child) => child.name())).toEqual([
      "get",
      "list",
      "invoke",
      "target",
      "connector",
      "rule",
      "policy",
    ]);
    for (const group of ["target", "connector", "rule"]) {
      const sub = gateway.commands.find((child) => child.name() === group)!;
      expect(sub.commands.map((child) => child.name())).toEqual(["get", "list"]);
    }
    expect(gateway.commands.find((child) => child.name() === "policy")?.commands[0]?.name()).toBe(
      "generate",
    );
  });

  test.each(REMOVED)("rejects %s without calling Core", async (path) => {
    for (const args of [[], ["--json"], ["--name", "removed"]]) {
      const { core, command } = setup();
      await expect(
        command.parseAsync(["node", "agentcore", ...path.split(" "), ...args]),
      ).rejects.toThrow();
      expect(core.gateway.calls).toEqual([]);
      expect(core.policy.calls).toEqual([]);
    }
  });
});
