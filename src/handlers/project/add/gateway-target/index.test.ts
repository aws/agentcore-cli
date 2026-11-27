import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../../../errors";
import { expectError } from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { BOX_RELEASE } from "../../../../core/project/backends/boxRelease";
import { boxGatewaySpec } from "../../../../projectSchemas/project";

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
  test("names the bound runtime when the target goes on a Box gateway", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    const runtime = spec.runtimes[0].name;
    const box = boxGatewaySpec(runtime, "strands-box");
    await writeProjectSpec(projectRoot, {
      ...spec,
      projectType: "box",
      runtimes: spec.runtimes.map((runtime: object) => ({ ...runtime, platformVersion: "V2" })),
      agentCoreGateways: [box],
    });
    await addGateway();

    const onBox = await run([
      "add",
      "gateway-target",
      ...["--gateway", box.name, "--name", "search", "--endpoint", ENDPOINT],
      ...["--outbound-auth", "none"],
    ]);
    const onTools = await run([
      "add",
      "gateway-target",
      ...["--gateway", "tools", "--name", "docs", "--endpoint", ENDPOINT],
      ...["--outbound-auth", "none"],
    ]);

    const note = `Gateway '${box.name}' is bound to runtime '${runtime}', so only that runtime gets its variables`;
    expect(onBox.stderr()).toContain(note);
    expect(onTools.stderr()).not.toContain("bound to runtime");

    const asJson = await run([
      "add",
      "gateway-target",
      ...["--gateway", box.name, "--name", "wiki", "--endpoint", ENDPOINT],
      ...["--outbound-auth", "none", "--json"],
    ]);
    expect(JSON.parse(asJson.stdout()).notes).toEqual([note]);
  });

  /** A Box project with its Box gateway and the `tools` gateway; `boxed` gives the runtime a box. */
  async function boxProject(boxed: boolean) {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    const runtime = spec.runtimes[0];
    const box = boxGatewaySpec(runtime.name, "strands-box");
    await writeProjectSpec(projectRoot, {
      ...spec,
      projectType: "box",
      runtimes: [
        boxed
          ? { ...runtime, box: { version: BOX_RELEASE.version }, platformVersion: "V2" as const }
          : { ...runtime, platformVersion: "V2" as const },
      ],
      agentCoreGateways: [box],
    });
    await addGateway();
    return { projectRoot, box };
  }

  async function targetNames(projectRoot: string, gateway: string): Promise<string[]> {
    return (await projectSpec(projectRoot)).agentCoreGateways
      .find((candidate: { name: string }) => candidate.name === gateway)
      .targets.map((target: { name: string }) => target.name);
  }

  const BUILD_OWNED_NAMES = ["bedrock", "agentcore", "egress-api-example-com"];

  test.each(BUILD_OWNED_NAMES)(
    "refuses the build-owned name %s on a Box gateway, and only there",
    async (name) => {
      const { projectRoot, box } = await boxProject(true);

      await expectError(
        run([
          "add",
          "gateway-target",
          ...["--gateway", box.name, "--name", name, "--endpoint", ENDPOINT],
          ...["--outbound-auth", "none"],
        ]),
        `the gateway target name '${name}' is reserved on Box gateway '${box.name}': build ` +
          `owns the names 'bedrock', 'agentcore', 'egress-*' for the agent's model calls, Memory ` +
          `route, and egress targets. Choose another name.`,
        InputValidationError,
      );
      // The same name is the user's on a gateway that is not a Box gateway.
      await run([
        "add",
        "gateway-target",
        ...["--gateway", "tools", "--name", name, "--endpoint", ENDPOINT],
        ...["--outbound-auth", "none"],
      ]);

      expect(await targetNames(projectRoot, box.name)).toEqual([]);
      expect(await targetNames(projectRoot, "tools")).toEqual([name]);
    },
  );

  test.each(BUILD_OWNED_NAMES)(
    "accepts the name %s on a bound gateway whose runtime does not run in a box",
    async (name) => {
      // A Box project runtime with no box.version: build writes no targets on its gateway.
      const { projectRoot, box } = await boxProject(false);

      await run([
        "add",
        "gateway-target",
        ...["--gateway", box.name, "--name", name, "--endpoint", ENDPOINT],
        ...["--outbound-auth", "none"],
      ]);

      expect(await targetNames(projectRoot, box.name)).toEqual([name]);
    },
  );

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
      "agent",
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
        httpRuntime: { runtime: "agent", runtimeEndpoint: "DEFAULT" },
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

  test("accepts configured IAM auth through --target-configuration", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const targets = [
      {
        name: "mcp-iam",
        targetType: "mcpServer",
        endpoint: ENDPOINT,
        outboundAuth: {
          type: "GATEWAY_IAM_ROLE",
          service: "bedrock-agentcore",
          region: "us-east-1",
        },
      },
      {
        name: "openapi-iam",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
        outboundAuth: {
          type: "GATEWAY_IAM_ROLE",
          service: "execute-api",
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

  test.each<
    [label: string, flags: string[], message: string, errorType?: Parameters<typeof expectError>[2]]
  >([
    [
      "missing parent Gateway",
      ["--name", "target", "--endpoint", ENDPOINT],
      "required option '--gateway",
    ],
    ["no Target mode", ["--gateway", "tools", "--name", "target"], "specify exactly one"],
    ["multiple Target modes", [...endpointFlags(), "--runtime", "agent"], "specify exactly one"],
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
      "unknown credential",
      endpointFlags("--outbound-auth", "oauth", "--credential-name", "missing"),
      "no credential named 'missing' exists in this project",
      ResourceNotFoundError,
    ],
    [
      "credential with wrong type",
      endpointFlags("--outbound-auth", "oauth", "--credential-name", "api-key"),
      "not a OAuthCredentialProvider",
    ],
    [
      "unknown Gateway",
      ["--gateway", "missing", "--name", "target", "--endpoint", ENDPOINT],
      "no gateway named 'missing' exists in this project",
      ResourceNotFoundError,
    ],
  ])("rejects %s", async (_label, flags, message, errorType = InputValidationError) => {
    await projectWithCredentials();
    await expectError(run(["add", "gateway-target", ...flags]), message, errorType);
  });

  test("rejects an API-key endpoint shortcut unsupported by the project schema", async () => {
    await projectWithCredentials();
    await expectError(
      run([
        "add",
        "gateway-target",
        ...endpointFlags("--outbound-auth", "api-key", "--credential-name", "api-key"),
      ]),
      "mcpServer targets do not support API_KEY outbound auth",
      ProjectStateError,
    );
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
});
