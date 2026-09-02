import { describe, expect, test } from "bun:test";
import {
  GetGatewayCommand,
  GetPolicyGenerationCommand,
  StartPolicyGenerationCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { PolicyClient } from "../../core/policy";
import type { AwsClients } from "../../core/types";
import { NetworkingError } from "../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { compile, isTuiCommandSupported, ValueContext } from "../../router";
import { createRootHandler } from "../index";
import type { Core } from "../types";

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-1";
const TARGET_ID = "target-1";
const RULE_ID = "rule-1";

async function run<C extends Core>(
  args: string[],
  core: C = new TestCoreClient() as unknown as C,
): Promise<{ core: C; stdout: string }> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout() };
}

function supportsTui(path: readonly string[]): boolean {
  let command = compile(
    createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    }),
    ValueContext.EmptyContext(),
  );

  for (const name of path) {
    const child = command.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`missing command ${path.join(" ")}`);
    command = child;
  }
  return isTuiCommandSupported(command);
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
    const policy = gateway?.children().find((child) => child.name() === "policy");

    expect(gateway?.flags().map((flag) => flag.name)).not.toContain("interactive");
    expect(gateway?.children().map((child) => child.name())).toEqual([
      "create",
      "update",
      "get",
      "list",
      "delete",
      "invoke",
      "target",
      "connector",
      "rule",
      "policy",
    ]);
    expect(target?.children().map((child) => child.name())).toEqual([
      "create",
      "update",
      "get",
      "list",
      "delete",
    ]);
    expect(connector?.children().map((child) => child.name())).toEqual([
      "create",
      "update",
      "get",
      "list",
      "delete",
    ]);
    expect(rule?.children().map((child) => child.name())).toEqual([
      "create",
      "update",
      "get",
      "list",
      "delete",
    ]);
    expect(policy?.children().map((child) => child.name())).toEqual(["generate"]);
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
  ] as const)("marks bare %s as TUI-supported", (_label, args) => {
    expect(supportsTui(args)).toBe(true);
  });

  test.each([
    ["Gateway create", ["gateway", "create"], /--name/],
    ["Target create", ["gateway", "target", "create"], /--gateway-id/],
    ["Connector create", ["gateway", "connector", "create"], /--gateway-id/],
    ["Rule create", ["gateway", "rule", "create"], /--gateway-id/],
  ] as const)("keeps bare CLI-only %s out of the TUI", async (_label, args, error) => {
    expect(supportsTui(args)).toBe(false);
    await expect(run([...args])).rejects.toThrow(error);
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
    ["Policy generate gateway", ["gateway", "policy", "generate", "--prompt", "x"], /--gateway-id/],
    [
      "Policy generate prompt",
      ["gateway", "policy", "generate", "--gateway-id", GATEWAY_ID],
      /--prompt/,
    ],
  ] as const)(
    "rejects a missing selector for %s before calling Core",
    async (_name, args, error) => {
      const core = new TestCoreClient();

      await expect(run([...args], core)).rejects.toThrow(error);
      expect(core.gateway.calls).toEqual([]);
      expect(core.policy.calls).toEqual([]);
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

/**
 The waiter outcomes below cannot be recorded against the live service, so the
 control plane is faked at .send() while the real PolicyClient and waiter run.
**/
describe("gateway policy generate against a faked control plane", () => {
  function coreWith(status: string, statusReasons?: string[]): Core {
    const control = {
      send: async (command: unknown) => {
        if (command instanceof GetGatewayCommand) {
          return {
            gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/gw-1",
            policyEngineConfiguration: {
              arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:policy-engine/pe-1",
            },
          };
        }
        if (command instanceof StartPolicyGenerationCommand) return { policyGenerationId: "gen-1" };
        if (command instanceof GetPolicyGenerationCommand) return { status, statusReasons };
        throw new Error(`unexpected command ${(command as object).constructor.name}`);
      },
    };
    const clients = { control: () => control } as unknown as AwsClients;
    return {
      ...new TestCoreClient(),
      policy: new PolicyClient(clients, createSilentLogger(), {
        maxWaitTime: 2,
        minDelay: 1,
        maxDelay: 1,
      }),
    };
  }

  const args = ["gateway", "policy", "generate", "--gateway-id", GATEWAY_ID, "--prompt", "x"];

  test("fails with the service reasons when the generation fails", async () => {
    await expect(
      run(args, coreWith("GENERATE_FAILED", ["bad prompt", "try again"])),
    ).rejects.toThrow("policy generation 'gen-1' failed: bad prompt; try again");
  });

  test("times out when the generation keeps running", async () => {
    const attempt = run(args, coreWith("GENERATING"));
    await expect(attempt).rejects.toBeInstanceOf(NetworkingError);
    await expect(attempt).rejects.toThrow("did not finish within 2s");
  }, 10_000);
});
