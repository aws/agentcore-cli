import { test, expect, describe } from "bun:test";
import { createRootHandler } from "./index";
import { DEFAULT_GLOBAL_CONFIG } from "../globalConfig";
import {
  compiledRootCommand,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../testing";

const PUBLIC_COMMANDS = [
  "create",
  "add",
  "export",
  "remove",
  "dev",
  "deploy",
  "invoke",
  "log",
  "traces",
  "status",
  "build",
  "eval",
  "feedback",
  "config",
  "update",
];
const STANDALONE_COMMANDS = ["harness", "identity", "runtime", "memory", "gateway", "payment"];

describe("createRootHandler", () => {
  test("builds the agentcore command tree with its subcommands", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    expect(root.name()).toBe("agentcore");
    expect(root.children().map((c) => c.name())).toEqual(PUBLIC_COMMANDS);
  });

  test.each([false, true])("registers standalone commands for imperative flag %s", (enabled) => {
    const command = compiledRootCommand(undefined, {
      ...DEFAULT_GLOBAL_CONFIG,
      "imperative-commands": enabled,
    });
    const names = command.commands.map((child) => child.name());
    expect(names.filter((name) => !STANDALONE_COMMANDS.includes(name))).toEqual(PUBLIC_COMMANDS);
    for (const name of STANDALONE_COMMANDS) {
      expect(names.includes(name)).toBe(enabled);
      expect(new RegExp(`\\n\\s+${name}\\s`).test(command.helpInformation())).toBe(enabled);
    }
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toEqual(
      expect.arrayContaining(["harness", "runtime", "memory", "gateway"]),
    );
  });

  test.each(STANDALONE_COMMANDS)("rejects disabled %s before command dispatch", async (name) => {
    const command = compiledRootCommand();
    command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    await expect(command.parseAsync(["node", "agentcore", name, "--json"])).rejects.toThrow(
      `unknown command '${name}' for 'agentcore'`,
    );
  });
});
