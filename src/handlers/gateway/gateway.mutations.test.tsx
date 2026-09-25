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
import { createGatewayHandler } from "./index";

const GROUPS = [[], ["target"], ["connector"], ["rule"]];
const MUTATIONS = ["create", "update", "delete"];

function setup(enabled?: boolean) {
  const core = new TestCoreClient();
  const io = testIO();
  const globalConfig =
    enabled === undefined
      ? DEFAULT_GLOBAL_CONFIG
      : {
          ...DEFAULT_GLOBAL_CONFIG,
          "imperative-commands": enabled,
        };
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({ initialConfigData: globalConfig }),
    globalConfig,
  });
  const command = compile(root, ValueContext.EmptyContext());
  command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return { core, command };
}

describe("Gateway imperative mutation availability", () => {
  test("Gateway factory registers all mutations without a separate gate", () => {
    const gateway = createGatewayHandler(new TestCoreClient(), testIO().io);
    for (const path of GROUPS) {
      const group = path.length
        ? gateway.children().find((child) => child.name() === path[0])!
        : gateway;
      const names = group.children().map((child) => child.name());
      for (const mutation of MUTATIONS) {
        expect(names).toContain(mutation);
      }
    }
  });

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
    const gateway = root.children().find((child) => child.name() === "gateway")!;
    expect(gateway.children().map((child) => child.name())).toContain("create");
    expect(reads).toBe(0);
  });

  test.each([undefined, false, true])("builds help and commands for parent flag %s", (enabled) => {
    const { command } = setup(enabled);
    const gateway = command.commands.find((child) => child.name() === "gateway");
    expect(Boolean(gateway)).toBe(enabled === true);
    expect(/\n\s+gateway\s/.test(command.helpInformation())).toBe(enabled === true);
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toContain("gateway");
    if (!gateway) return;
    for (const path of GROUPS) {
      const group = path.length
        ? gateway.commands.find((child) => child.name() === path[0])!
        : gateway;
      const names = group.commands.map((child) => child.name());
      for (const mutation of MUTATIONS) {
        expect(names).toContain(mutation);
        expect(group.helpInformation()).toMatch(new RegExp(`\\n\\s+${mutation}\\s`));
      }
      expect(names).toContain("get");
      expect(names).toContain("list");
    }
    expect(gateway.commands.map((child) => child.name())).toContain("invoke");
    expect(gateway.commands.find((child) => child.name() === "policy")?.commands[0]?.name()).toBe(
      "generate",
    );
    const harness = command.commands.find((child) => child.name() === "harness")!;
    expect(harness.commands.map((child) => child.name())).toContain("create");
  });

  test.each(
    GROUPS.flatMap((group) =>
      MUTATIONS.map((mutation) => ["gateway", ...group, mutation].join(" ")),
    ),
  )("rejects disabled %s without calling Core", async (path) => {
    for (const enabled of [undefined, false]) {
      for (const args of [[], ["--json"], ["--name", "disabled"]]) {
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
