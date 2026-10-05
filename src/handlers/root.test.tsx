import { test, expect, describe } from "bun:test";
import { createRootHandler } from "./index";
import {
  compiledRootCommand,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../testing";

// The order `agentcore --help` and the TUI root menu list the commands in.
const WORKFLOW_ORDER = [
  "create",
  "dev",
  "deploy",
  "invoke",
  "status",
  "logs",
  "traces",
  "add",
  "remove",
  "export",
  "build",
];
const RESOURCES_ORDER = ["harness", "runtime", "gateway", "identity", "memory", "eval", "payment"];
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
    expect(root.children().map((c) => c.name())).toEqual([
      ...WORKFLOW_ORDER,
      ...RESOURCES_ORDER,
      ...SETTINGS_ORDER,
    ]);
  });

  test("registers the resource commands alongside the project workflow", () => {
    const command = compiledRootCommand();
    const names = command.commands.map((child) => child.name());
    for (const name of RESOURCES_ORDER) {
      expect(names).toContain(name);
      expect(new RegExp(`\\n\\s+${name}\\s`).test(command.helpInformation())).toBe(true);
    }
    const add = command.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toEqual(
      expect.arrayContaining(["harness", "runtime", "memory", "gateway"]),
    );
  });

  test("--help lists commands in the root menu order", () => {
    const command = compiledRootCommand();
    expect(helpCommandNames(command.helpInformation())).toEqual([
      ...WORKFLOW_ORDER,
      ...RESOURCES_ORDER,
      ...SETTINGS_ORDER,
    ]);
  });
});
