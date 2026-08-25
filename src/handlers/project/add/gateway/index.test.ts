import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec, run, writeProjectSpec } =
  createGatewayProjectTestHarness("gateway-add");

afterEach(cleanup);

describe("project add gateway", () => {
  test("adds the default unrestricted Gateway", async () => {
    const projectRoot = await inProject();
    const io = await run(["add", "gateway", "--name", "tools"]);

    expect((await projectSpec(projectRoot)).agentCoreGateways).toEqual([
      {
        name: "tools",
        protocolType: "None",
        targets: [],
        authorizerType: "NONE",
        enableSemanticSearch: false,
        exceptionLevel: "NONE",
      },
    ]);
    expect(io.stderr()).toContain("added Gateway 'tools'");
  });

  test("maps scalar flags directly to Gateway project fields", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.policyEngines = [{ name: "Guardrails", policies: [] }];
    await writeProjectSpec(projectRoot, spec);

    await run([
      "add",
      "gateway",
      "--name",
      "tools",
      "--protocol-type",
      "MCP",
      "--enable-semantic-search",
      "--role-arn",
      "arn:aws:iam::123456789012:role/GatewayRole",
      "--description",
      "Project tools",
      "--policy-engine-name",
      "Guardrails",
      "--policy-engine-mode",
      "enforce",
      "--exception-level",
      "debug",
      "--tags",
      '{"team":"agents"}',
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      name: "tools",
      protocolType: "MCP",
      description: "Project tools",
      authorizerType: "NONE",
      enableSemanticSearch: true,
      exceptionLevel: "DEBUG",
      executionRoleArn: "arn:aws:iam::123456789012:role/GatewayRole",
      policyEngineConfiguration: { policyEngineName: "Guardrails", mode: "ENFORCE" },
      tags: { team: "agents" },
    });
  });

  test("reads project authorizerConfiguration from stdin without translation", async () => {
    const projectRoot = await inProject();
    await run(
      [
        "add",
        "gateway",
        "--name",
        "secure",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        "-",
      ],
      JSON.stringify({
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["agentcore"],
        },
      }),
    );

    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["agentcore"],
        },
      },
    });
  });

  test("rejects the SDK authorizer shape without writing a Gateway", async () => {
    const projectRoot = await inProject();
    await expect(
      run([
        "add",
        "gateway",
        "--name",
        "secure",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration"}}',
      ]),
    ).rejects.toThrow("customJWTAuthorizer");

    expect((await projectSpec(projectRoot)).agentCoreGateways ?? []).toEqual([]);
  });

  test("maps log-only policy mode", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.policyEngines = [{ name: "Guardrails", policies: [] }];
    await writeProjectSpec(projectRoot, spec);

    await run([
      "add",
      "gateway",
      "--name",
      "tools",
      "--policy-engine-name",
      "Guardrails",
      "--policy-engine-mode",
      "log-only",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].policyEngineConfiguration).toEqual(
      {
        policyEngineName: "Guardrails",
        mode: "LOG_ONLY",
      },
    );
  });

  test("maps repeated key=value tags", async () => {
    const projectRoot = await inProject();
    await run(["add", "gateway", "--name", "tools", "--tags", "source=pairs", "team=agents"]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].tags).toEqual({
      source: "pairs",
      team: "agents",
    });
  });

  test.each([
    ["missing --name", ["add", "gateway"], "required option '--name"],
    [
      "service resource name exceeds 48 characters",
      ["add", "gateway", "--name", "gateway-name-that-is-far-too-long-for-the-service"],
      "exceeds the service limit",
    ],
    [
      "policy engine name without mode",
      ["add", "gateway", "--name", "tools", "--policy-engine-name", "Guardrails"],
      "must be supplied together",
    ],
    [
      "policy engine mode without name",
      ["add", "gateway", "--name", "tools", "--policy-engine-mode", "enforce"],
      "must be supplied together",
    ],
    [
      "unknown policy engine",
      [
        "add",
        "gateway",
        "--name",
        "tools",
        "--policy-engine-name",
        "Missing",
        "--policy-engine-mode",
        "enforce",
      ],
      "does not exist in policyEngines[]",
    ],
    [
      "CUSTOM_JWT without configuration",
      ["add", "gateway", "--name", "tools", "--authorizer-type", "CUSTOM_JWT"],
      "CUSTOM_JWT requires --authorizer-configuration",
    ],
    [
      "configuration without CUSTOM_JWT",
      [
        "add",
        "gateway",
        "--name",
        "tools",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com"}}',
      ],
      "valid only with CUSTOM_JWT",
    ],
    [
      "semantic search without an MCP-only Gateway",
      ["add", "gateway", "--name", "tools", "--enable-semantic-search"],
      "--protocol-type MCP",
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(args)).rejects.toThrow(message);
  });
});
