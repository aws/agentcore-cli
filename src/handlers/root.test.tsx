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

const STANDALONE_COMMANDS = ["harness", "identity", "runtime", "memory", "gateway", "payment"];

// The order `agentcore --help` and the TUI root menu list the commands in.
const WORKFLOW_ORDER = [
  "create",
  "add",
  "remove",
  "dev",
  "build",
  "deploy",
  "status",
  "invoke",
  "log",
  "traces",
  "export",
  "eval",
];
const RESOURCES_ORDER = ["gateway", "harness", "identity", "memory", "payment", "runtime"];
const SETTINGS_ORDER = ["feedback", "config", "update"];

// helpCommandNames reads the command names off the "Commands:" section of help.
function helpCommandNames(help: string): string[] {
  const section = help.split("Commands:\n")[1] ?? "";
  return [...section.matchAll(/^ {2}([a-z][a-z0-9-]*)\s/gm)].map((match) => match[1]!);
}

describe("createRootHandler", () => {
  test("builds the agentcore command tree with its subcommands", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    expect(root.name()).toBe("agentcore");
    expect(root.children().map((c) => c.name())).toEqual([...WORKFLOW_ORDER, ...SETTINGS_ORDER]);
  });

  test.each([false, true])("registers standalone commands for imperative flag %s", (enabled) => {
    const command = compiledRootCommand(undefined, {
      ...DEFAULT_GLOBAL_CONFIG,
      "imperative-commands": enabled,
    });
    const names = command.commands.map((child) => child.name());
    expect(names.filter((name) => !STANDALONE_COMMANDS.includes(name))).toEqual([
      ...WORKFLOW_ORDER,
      ...SETTINGS_ORDER,
    ]);
    for (const name of STANDALONE_COMMANDS) {
      expect(names.includes(name)).toBe(enabled);
      expect(new RegExp(`\\n\\s+${name}\\s`).test(command.helpInformation())).toBe(enabled);
    }
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toEqual(
      expect.arrayContaining(["harness", "runtime", "memory", "gateway"]),
    );
  });

  test.each([false, true])(
    "--help lists commands in the root menu order for imperative flag %s",
    (enabled) => {
      const command = compiledRootCommand(undefined, {
        ...DEFAULT_GLOBAL_CONFIG,
        "imperative-commands": enabled,
      });
      expect(helpCommandNames(command.helpInformation())).toEqual([
        ...WORKFLOW_ORDER,
        ...(enabled ? RESOURCES_ORDER : []),
        ...SETTINGS_ORDER,
      ]);
    },
  );

  test.each(STANDALONE_COMMANDS)("rejects disabled %s before command dispatch", async (name) => {
    const command = compiledRootCommand();
    command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    await expect(command.parseAsync(["node", "agentcore", name, "--json"])).rejects.toThrow(
      `unknown command '${name}' for 'agentcore'`,
    );
  });
});
