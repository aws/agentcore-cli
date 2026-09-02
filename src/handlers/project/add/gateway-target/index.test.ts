import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";
const ENDPOINT = "https://mcp.example.com";
const OAUTH_CREDENTIAL = {
  authorizerType: "OAuthCredentialProvider",
  name: "oauth",
  discoveryUrl: DISCOVERY_URL,
};
const API_KEY_CREDENTIAL = {
  authorizerType: "ApiKeyCredentialProvider",
  name: "api-key",
};

const { addGateway, cleanup, inProject, projectSpec, run, writeProjectSpec } =
  createGatewayProjectTestHarness("gateway-target");

afterEach(cleanup);

function endpointFlags(...extra: string[]): string[] {
  return ["--gateway", "tools", "--name", "target", "--endpoint", ENDPOINT, ...extra];
}

async function projectWithCredentials() {
  const projectRoot = await inProject();
  const spec = await projectSpec(projectRoot);
  spec.credentials = [OAUTH_CREDENTIAL, API_KEY_CREDENTIAL];
  await writeProjectSpec(projectRoot, spec);
  await addGateway();
  return projectRoot;
}

describe("project add gateway-target", () => {
  test("adds endpoint and project Runtime shortcuts", async () => {
    const projectRoot = await inProject();
    await addGateway();

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "external",
      "--endpoint",
      ENDPOINT,
      "--outbound-auth",
      "none",
    ]);
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "runtime",
      "--runtime",
      "agent_python",
      "--runtime-endpoint",
      "DEFAULT",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual([
      {
        name: "external",
        targetType: "mcpServer",
        endpoint: ENDPOINT,
        outboundAuth: { type: "NONE" },
      },
      {
        name: "runtime",
        targetType: "httpRuntime",
        httpRuntime: { runtime: "agent_python", runtimeEndpoint: "DEFAULT" },
      },
    ]);
  });

  test("persists complete project Target shapes without translation or asset creation", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const targets = [
      {
        name: "search",
        targetType: "lambdaFunctionArn",
        lambdaFunctionArn: {
          lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
          toolSchemaFile: "schemas/tool-schema.json",
        },
      },
      {
        name: "local-tool",
        targetType: "lambda",
        toolDefinitions: [
          {
            name: "search",
            description: "Search documents",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        compute: {
          host: "Lambda",
          implementation: {
            language: "Python",
            path: "app/search-tool",
            handler: "handler.py:handler",
          },
          pythonVersion: "PYTHON_3_12",
        },
      },
    ];

    for (const target of targets) {
      await run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        JSON.stringify(target),
      ]);
    }

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual(targets);
    expect(await Bun.file(join(projectRoot, "agentcore", "assets")).exists()).toBe(false);
  });

  test("reads complete Target JSON from a file", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const target = {
      name: "source",
      targetType: "mcpServer",
      endpoint: "https://source.example.com",
    };
    const path = join(projectRoot, "target.json");
    await writeFile(path, JSON.stringify(target));

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--target-configuration",
      `file://${path}`,
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
  });

  test("rejects shortcut flags with complete Target JSON", async () => {
    await inProject();
    await addGateway();
    const target = JSON.stringify({
      name: "source",
      targetType: "mcpServer",
      endpoint: "https://source.example.com",
    });

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "duplicate",
        "--target-configuration",
        target,
      ]),
    ).rejects.toThrow("--name is part of --target-configuration");
    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        target,
        "--outbound-auth",
        "none",
      ]),
    ).rejects.toThrow("outboundAuth is part of --target-configuration");
  });

  test("validates direct project credential references", async () => {
    const projectRoot = await projectWithCredentials();
    const targets = [
      {
        name: "oauth",
        targetType: "mcpServer",
        endpoint: "https://oauth.example.com",
        outboundAuth: {
          type: "OAUTH",
          credentialName: "oauth",
          scopes: ["read", "write"],
        },
      },
      {
        name: "api-key",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
        outboundAuth: { type: "API_KEY", credentialName: "api-key" },
      },
    ];

    for (const target of targets) {
      await run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        JSON.stringify(target),
      ]);
    }

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual(targets);
  });

  test("adds an OAuth-authenticated endpoint shortcut", async () => {
    const projectRoot = await projectWithCredentials();

    await run([
      "add",
      "gateway-target",
      ...endpointFlags(
        "--outbound-auth",
        "oauth",
        "--credential-name",
        "oauth",
        "--scope",
        "read",
        "write",
      ),
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0].outboundAuth).toEqual({
      type: "OAUTH",
      credentialName: "oauth",
      scopes: ["read", "write"],
    });
  });

  test.each([
    [
      "missing parent Gateway",
      ["--name", "target", "--endpoint", ENDPOINT],
      "required option '--gateway",
    ],
    ["no Target mode", ["--gateway", "tools", "--name", "target"], "specify exactly one"],
    [
      "multiple Target modes",
      [...endpointFlags(), "--runtime", "agent_python"],
      "specify exactly one",
    ],
    [
      "runtime endpoint without Runtime mode",
      [...endpointFlags(), "--runtime-endpoint", "DEFAULT"],
      "--runtime-endpoint requires --runtime",
    ],
    [
      "shortcut without name",
      ["--gateway", "tools", "--endpoint", ENDPOINT],
      "required option '--name",
    ],
    [
      "non-HTTPS endpoint",
      ["--gateway", "tools", "--name", "target", "--endpoint", "http://mcp.example.com"],
      "must use HTTPS",
    ],
    [
      "invalid endpoint",
      ["--gateway", "tools", "--name", "target", "--endpoint", "not-a-url"],
      "must be a valid HTTPS URL",
    ],
    [
      "credential without auth type",
      endpointFlags("--credential-name", "oauth"),
      "--credential-name requires --outbound-auth",
    ],
    [
      "scope without auth type",
      endpointFlags("--scope", "read"),
      "--scope requires --outbound-auth oauth",
    ],
    [
      "none auth with credential",
      endpointFlags("--outbound-auth", "none", "--credential-name", "oauth"),
      "cannot be combined",
    ],
    [
      "OAuth without credential",
      endpointFlags("--outbound-auth", "oauth"),
      "requires --credential-name",
    ],
    [
      "API key with OAuth scope",
      endpointFlags(
        "--outbound-auth",
        "api-key",
        "--credential-name",
        "api-key",
        "--scope",
        "read",
      ),
      "--scope is valid only with --outbound-auth oauth",
    ],
    [
      "API-key endpoint shortcut unsupported by the project schema",
      endpointFlags("--outbound-auth", "api-key", "--credential-name", "api-key"),
      "mcpServer targets do not support API_KEY outbound auth",
    ],
    [
      "unknown credential",
      endpointFlags("--outbound-auth", "oauth", "--credential-name", "missing"),
      "does not exist in credentials[]",
    ],
    [
      "credential with wrong type",
      endpointFlags("--outbound-auth", "oauth", "--credential-name", "api-key"),
      "not a OAuthCredentialProvider",
    ],
    [
      "unknown Gateway",
      ["--gateway", "missing", "--name", "target", "--endpoint", ENDPOINT],
      "does not exist in this project; check agentCoreGateways in agentcore.json",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    await projectWithCredentials();
    await expect(run(["add", "gateway-target", ...flags])).rejects.toThrow(message);
  });

  test("rejects a direct API-key reference to an OAuth credential", async () => {
    await projectWithCredentials();

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        JSON.stringify({
          name: "target",
          targetType: "openApiSchema",
          schemaSource: { inline: { path: "openapi.json" } },
          outboundAuth: { type: "API_KEY", credentialName: "oauth" },
        }),
      ]),
    ).rejects.toThrow("not a ApiKeyCredentialProvider");
  });

  test("rejects duplicate Target names within or across Gateways", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    await addGateway("payments");
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--endpoint",
      "https://tools.example.com",
    ]);

    for (const gateway of ["tools", "payments"]) {
      await expect(
        run([
          "add",
          "gateway-target",
          "--gateway",
          gateway,
          "--name",
          "search",
          "--endpoint",
          `https://${gateway}.example.com`,
        ]),
      ).rejects.toThrow("already exists in gateway 'tools'");
    }

    const gateways = (await projectSpec(projectRoot)).agentCoreGateways;
    expect(gateways[0].targets).toHaveLength(1);
    expect(gateways[1].targets).toHaveLength(0);
  });

  test("rejects a Target name already present in unassignedTargets", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.unassignedTargets = [
      {
        name: "search",
        targetType: "mcpServer",
        endpoint: "https://unassigned.example.com",
      },
    ];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "search",
        "--endpoint",
        "https://tools.example.com",
      ]),
    ).rejects.toThrow("unassigned gateway target");
  });
});
