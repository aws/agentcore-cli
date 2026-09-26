import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_GLOBAL_CONFIG } from "../globalConfig";
import { CommandKey } from "../router";
import {
  cleanupScreens,
  compiledRootCommand,
  renderScreen,
  TestCoreClient,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);

function expectNoResourceCalls(core: TestCoreClient) {
  expect([
    ...core.harness.calls,
    ...core.runtime.calls,
    ...core.gateway.calls,
    ...core.policy.calls,
  ]).toEqual([]);
}

const MUTATION_ROUTES = [
  "harness/create",
  "harness/update",
  "harness/update/update",
  "harness/delete",
  "harness/delete/delete",
  "harness/endpoint/create",
  "harness/endpoint/create/update",
  "harness/endpoint/update",
  "harness/endpoint/update/update",
  "harness/endpoint/update/update/delete",
  "harness/endpoint/delete",
  "harness/endpoint/delete/delete",
  "harness/endpoint/delete/delete/update",
  "harness/invoke",
  "harness/invoke/update",
  "harness/invoke/update/delete",
  "harness/exec",
  "harness/exec/update",
  "harness/exec/update/delete",
  "runtime/invoke",
  "runtime/invoke/update",
  "runtime/invoke/update/delete",
  "runtime/shell",
  "runtime/shell/update",
  "runtime/shell/update/delete",
  "gateway/invoke",
  "gateway/invoke/update",
  "gateway/policy",
  "gateway/policy/generate",
  "gateway/policy/generate/delete",
];

describe("disabled imperative routes", () => {
  test.each(MUTATION_ROUTES)("%s redirects before mounting its screen", async (path) => {
    const core = new TestCoreClient();
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });

    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expect(screen.lastFrame()).toContain("type to choose a command");
    expectNoResourceCalls(core);
  });

  test("unavailable Gateway creation shows project guidance, not another command's help", async () => {
    const core = new TestCoreClient();
    const screen = renderScreen("/agentcore/gateway/create", {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });
    await waitForText(screen.lastFrame, "Create an AgentCore Gateway");
    expect(screen.lastFrame()).not.toContain("this command runs from the command line");
    expectNoResourceCalls(core);
  });
});

describe("public project invocation does not enable other commands", () => {
  test.each([
    ["harness", "harness/invoke"],
    ["runtime", "runtime/invoke"],
    ["harness", "runtime/invoke/update/DEFAULT"],
    ["runtime", "harness/invoke/update"],
    ["harness", "harness/exec/update"],
    ["runtime", "runtime/shell/update/DEFAULT"],
    ["harness", "harness/update/update"],
    ["runtime", "gateway/invoke/update"],
  ] as const)("project invoke %s does not authorize %s", async (family, path) => {
    const core = new TestCoreClient();
    const launch = compiledRootCommand(core, DEFAULT_GLOBAL_CONFIG)
      .commands.find((command) => command.name() === "invoke")!
      .commands.find((command) => command.name() === family)!;
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
      withContext: (ctx) => ctx.withValue(CommandKey, launch),
    });
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expectNoResourceCalls(core);
  });
});
