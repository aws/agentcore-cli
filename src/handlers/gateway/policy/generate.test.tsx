import { describe, expect, test } from "bun:test";
import { NetworkingError } from "../../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/gw-1";
const FORBID = "forbid (principal, action, resource is AgentCore::Gateway);";
const PERMIT = "permit (principal, action, resource is AgentCore::Gateway);";

function subject(stdin?: string) {
  const core = new TestCoreClient();
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    route: (args: string[]) =>
      root.route([
        "node",
        "agentcore",
        "gateway",
        "policy",
        "generate",
        ...args,
        "--region",
        REGION,
      ]),
  };
}

describe("gateway policy generate", () => {
  test.each([
    ["--gateway-id", []],
    ["--prompt", ["--gateway-id", "gw-1"]],
  ])("rejects a missing %s before calling the service", async (flag, args) => {
    const { core, route } = subject();
    await expect(route(args)).rejects.toThrow(`required option '${flag}`);
    expect(core.policy.calls).toEqual([]);
  });

  test("prints the Cedar on stdout and the findings on stderr", async () => {
    const { core, io, route } = subject("deny everything\n");
    core.policy.result = {
      policyGenerationId: "gen-1",
      policyEngineId: "pe-explicit",
      gatewayArn: GATEWAY_ARN,
      policies: [
        {
          statement: FORBID,
          findings: [{ type: "DENY_ALL", description: "denies every request" }],
        },
        { statement: undefined, findings: [{ type: "INVALID", description: "Non-translatable" }] },
        { statement: PERMIT, findings: [] },
      ],
    };

    await route([
      "--gateway-id",
      GATEWAY_ARN,
      "--policy-engine-id",
      "pe-explicit",
      "--prompt",
      "-",
      "--name",
      "my_generation",
    ]);

    expect(core.policy.calls).toEqual([
      {
        gatewayId: GATEWAY_ARN,
        policyEngineId: "pe-explicit",
        prompt: "deny everything\n",
        name: "my_generation",
      },
    ]);
    expect(io.stdout()).toBe(`${FORBID}\n\n${PERMIT}`);
    expect(io.stderr()).toBe(
      [
        "Generating policy",
        "Findings:",
        "  policy 1  [DENY_ALL]  denies every request",
        "  policy 2  [INVALID]  Non-translatable",
      ].join("\n"),
    );
  });

  test("prints the result object with --json and defaults the generation name", async () => {
    const { core, io, route } = subject();

    await route(["--gateway-id", "gw-1", "--prompt", "deny everything", "--json"]);

    expect(core.policy.calls[0]).toMatchObject({
      gatewayId: "gw-1",
      policyEngineId: undefined,
      prompt: "deny everything",
    });
    expect(core.policy.calls[0]!.name).toMatch(/^cli_generation_\d+$/);
    expect(JSON.parse(io.stdout())).toEqual(core.policy.result);
    expect(io.stderr()).toBe("Generating policy");
  });

  test("renders a --json error and writes no Cedar when generation fails", async () => {
    const { core, io, route } = subject();
    core.policy.error = new NetworkingError("policy generation 'gen-1' did not finish within 60s");

    await expect(
      route(["--gateway-id", "gw-1", "--prompt", "deny everything", "--json"]),
    ).rejects.toThrow("did not finish within 60s");
    expect(JSON.parse(io.stdout())).toEqual({
      error: "policy generation 'gen-1' did not finish within 60s",
    });
  });
});
