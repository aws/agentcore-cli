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
  "add",
  "dev",
  "deploy",
  "invoke",
  "status",
  "logs",
  "traces",
  "export",
  "migrate",
  "remove",
  "build",
];
const RESOURCES_ORDER = ["harness", "runtime", "gateway", "identity", "memory", "eval", "payment"];
const SETTINGS_ORDER = ["feedback", "config", "update"];

// helpCommandNames reads the command names under one command group.
function helpCommandNames(help: string, group: string): string[] {
  const section = help.split(`${group}:\n`)[1]?.split(/\n[A-Z][^:\n]*:\n/)[0] ?? "";
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

  test("add lists resources grouped in the top-level resource order", () => {
    const add = compiledRootCommand().commands.find((child) => child.name() === "add")!;
    expect(helpCommandNames(add.helpInformation(), "Commands")).toEqual([
      "harness",
      "runtime",
      "runtime-endpoint",
      "gateway",
      "gateway-target",
      "gateway-connector",
      "policy-engine",
      "policy",
      "credentials",
      "memory",
      "evaluator",
      "online-eval",
      "config-bundle",
      "payment-manager",
      "payment-connector",
    ]);
  });

  test("--help groups commands in the root menu order", () => {
    const command = compiledRootCommand();
    const help = command.helpInformation();
    expect(helpCommandNames(help, "Project")).toEqual(WORKFLOW_ORDER);
    expect(helpCommandNames(help, "Resources")).toEqual(RESOURCES_ORDER);
    expect(helpCommandNames(help, "Settings")).toEqual(SETTINGS_ORDER);
    expect(help.indexOf("Project:")).toBeLessThan(help.indexOf("Resources:"));
    expect(help.indexOf("Resources:")).toBeLessThan(help.indexOf("Settings:"));
  });
});
