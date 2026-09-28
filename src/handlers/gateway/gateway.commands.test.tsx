import { describe, expect, test } from "bun:test";
import { DEFAULT_GLOBAL_CONFIG } from "../../globalConfig";
import { compile, ValueContext } from "../../router";
import {
  createSilentLogger,
  IMPERATIVE_GLOBAL_CONFIG,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

// Gateways and their Targets, connectors, and Rules are created and changed
// through AgentCore projects, so the standalone group only reads, invokes,
// and deletes sub-resources.
const REMOVED = [
  "gateway create",
  "gateway update",
  "gateway delete",
  ...["target", "connector", "rule"].flatMap((group) => [
    `gateway ${group} create`,
    `gateway ${group} update`,
  ]),
];

function setup(enabled?: boolean) {
  const core = new TestCoreClient();
  const globalConfig =
    enabled === undefined
      ? DEFAULT_GLOBAL_CONFIG
      : { ...DEFAULT_GLOBAL_CONFIG, "imperative-commands": enabled };
  const root = createRootHandler(core, {
    io: testIO().io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({ initialConfigData: globalConfig }),
    globalConfig,
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
      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });
    expect(root.children().map((child) => child.name())).toContain("gateway");
    expect(reads).toBe(0);
  });

  test.each([undefined, false, true])("builds the Gateway group for parent flag %s", (enabled) => {
    const { command } = setup(enabled);
    const gateway = command.commands.find((child) => child.name() === "gateway");
    expect(Boolean(gateway)).toBe(enabled === true);
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toContain("gateway");
    if (!gateway) return;
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
      expect(sub.commands.map((child) => child.name())).toEqual(["get", "list", "delete"]);
    }
    expect(gateway.commands.find((child) => child.name() === "policy")?.commands[0]?.name()).toBe(
      "generate",
    );
  });

  test.each(REMOVED)("rejects %s without calling Core", async (path) => {
    for (const enabled of [undefined, false, true]) {
      for (const args of [[], ["--json"], ["--name", "removed"]]) {
        const { core, command } = setup(enabled);
        await expect(
          command.parseAsync(["node", "agentcore", ...path.split(" "), ...args]),
        ).rejects.toThrow();
        expect(core.gateway.calls).toEqual([]);
        expect(core.policy.calls).toEqual([]);
      }
    }
  });
});
