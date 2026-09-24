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
      ? IMPERATIVE_GLOBAL_CONFIG
      : {
          ...DEFAULT_GLOBAL_CONFIG,
          "imperative-mutation-commands": enabled,
          "imperative-commands": true,
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
  test("Gateway reads command availability from the resolved config", () => {
    for (const enabled of [false, true]) {
      const gateway = createGatewayHandler(new TestCoreClient(), testIO().io, {
        ...DEFAULT_GLOBAL_CONFIG,
        "imperative-mutation-commands": enabled,
        "imperative-commands": true,
      });
      const names = gateway.children().map((child) => child.name());
      for (const mutation of MUTATIONS) {
        expect(names.includes(mutation)).toBe(enabled);
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
      globalConfig: {
        ...DEFAULT_GLOBAL_CONFIG,
        "imperative-mutation-commands": true,
        "imperative-commands": true,
      },
    });
    const gateway = root.children().find((child) => child.name() === "gateway")!;
    expect(gateway.children().map((child) => child.name())).toContain("create");
    expect(reads).toBe(0);
  });

  test.each([undefined, false, true])("builds help and commands for flag %s", (enabled) => {
    const { command } = setup(enabled);
    const gateway = command.commands.find((child) => child.name() === "gateway")!;
    for (const path of GROUPS) {
      const group = path.length
        ? gateway.commands.find((child) => child.name() === path[0])!
        : gateway;
      const names = group.commands.map((child) => child.name());
      for (const mutation of MUTATIONS) {
        expect(names.includes(mutation)).toBe(enabled === true);
        expect(new RegExp(`\\n\\s+${mutation}\\s`).test(group.helpInformation())).toBe(
          enabled === true,
        );
      }
      expect(names).toContain("get");
      expect(names).toContain("list");
    }
    expect(gateway.commands.map((child) => child.name())).toContain("invoke");
    expect(gateway.commands.find((child) => child.name() === "policy")?.commands[0]?.name()).toBe(
      "generate",
    );
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toContain("gateway");
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
