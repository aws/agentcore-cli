import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { InputValidationError } from "../../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-runtime-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(args: string[], opts?: { core?: TestCoreClient }) {
  const io = testIO();
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project add runtime", () => {
  const template = ["--template", "hello-world-python"];

  const allScaffoldingFlags = [
    "--build",
    "CodeZip",
    "--language",
    "Python",
    "--framework",
    "none",
    "--model-provider",
    "Bedrock",
    "--memory",
    "none",
  ];

  const allInfrastructureFlags = [
    "--description",
    "Configured runtime",
    "--role-arn",
    "arn:aws:iam::123456789012:role/MyRole",
    "--additional-policies",
    "arn:aws:iam::123456789012:policy/MyPolicy",
    "--network-mode",
    "VPC",
    "--network-config",
    '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
    "--authorizer-type",
    "CUSTOM_JWT",
    "--authorizer-configuration",
    '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["app"]}}',
    "--request-header-allowlist",
    "X-Custom-Header",
    "--lifecycle-configuration",
    '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}',
    "--environment-variables",
    '{"LOG_LEVEL":"debug","APP_ENV":"staging"}',
    "--filesystem-configurations",
    '[{"sessionStorage":{"mountPath":"/mnt/data"}}]',
    "--tags",
    '{"team":"ml","env":"test"}',
  ];

  const expectedSpecByLabel: Record<string, Record<string, unknown>> = {
    "template overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
    },
    "container template build override to CodeZip": {
      build: "CodeZip",
    },
    "strands template overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
    },
    "py-mcp template preset": {
      build: "CodeZip",
      protocol: "MCP",
    },
    "py-mcp overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
      protocol: "MCP",
    },
    "custom MCP runtime": {
      build: "CodeZip",
      protocol: "MCP",
    },
    "strands-py-a2a template preset": {
      build: "CodeZip",
      protocol: "A2A",
    },
    "strands-py-a2a overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
      protocol: "A2A",
    },
    "custom A2A runtime": {
      build: "CodeZip",
      protocol: "A2A",
    },
    "all infrastructure flags": {
      description: "Configured runtime",
      executionRoleArn: "arn:aws:iam::123456789012:role/MyRole",
      additionalPolicies: ["arn:aws:iam::123456789012:policy/MyPolicy"],
      networkMode: "VPC",
      networkConfig: {
        subnets: ["subnet-0123456789abcdef0"],
        securityGroups: ["sg-0123456789abcdef0"],
      },
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["app"],
        },
      },
      requestHeaderAllowlist: ["X-Custom-Header"],
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
      envVars: [
        { name: "LOG_LEVEL", value: "debug" },
        { name: "APP_ENV", value: "staging" },
      ],
      filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/data" } }],
      tags: { team: "ml", env: "test" },
    },
  };

  test.each<[string, string[]]>([
    ["template preset", ["--name", "my_agent", ...template]],
    [
      "container template preset",
      ["--name", "my_agent", "--template", "hello-world-python-container"],
    ],
    ["strands-python template preset", ["--name", "my_agent", "--template", "strands-python"]],
    [
      "template overrides to Container",
      [
        "--name",
        "my_agent",
        "--template",
        "hello-world-python",
        "--build",
        "Container",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    [
      "container template build override to CodeZip",
      ["--name", "my_agent", "--template", "hello-world-python-container", "--build", "CodeZip"],
    ],
    [
      "strands template overrides to Container",
      ["--name", "my_agent", "--template", "strands-python", "--build", "Container"],
    ],
    ["py-mcp template preset", ["--name", "my_mcp", "--template", "py-mcp"]],
    [
      "py-mcp overrides to Container",
      ["--name", "my_mcp", "--template", "py-mcp", "--build", "Container"],
    ],
    ["strands-py-a2a template preset", ["--name", "my_a2a", "--template", "strands-py-a2a"]],
    [
      "strands-py-a2a overrides to Container",
      ["--name", "my_a2a", "--template", "strands-py-a2a", "--build", "Container"],
    ],
    [
      "custom A2A runtime",
      [
        "--name",
        "a2a_custom",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "strands",
        "--protocol",
        "A2A",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    [
      "strands-python with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_agent",
        "--template",
        "strands-python",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    [
      "py-mcp with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_mcp",
        "--template",
        "py-mcp",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    [
      "strands-py-a2a with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_a2a",
        "--template",
        "strands-py-a2a",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    [
      "custom MCP runtime",
      [
        "--name",
        "mcp_custom",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "none",
        "--protocol",
        "MCP",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    ["custom — all scaffolding flags", ["--name", "my_agent", ...allScaffoldingFlags]],
    [
      "custom — framework strands",
      [
        "--name",
        "strands_agent",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "strands",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    [
      "custom — container build",
      [
        "--name",
        "my_agent",
        "--build",
        "Container",
        "--language",
        "Python",
        "--framework",
        "none",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    ["description", ["--name", "my_agent", ...template, "--description", "A test agent"]],
    [
      "role-arn",
      ["--name", "my_agent", ...template, "--role-arn", "arn:aws:iam::123456789012:role/MyRole"],
    ],
    [
      "network — VPC",
      [
        "--name",
        "my_agent",
        ...template,
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
      ],
    ],
    ["network — PUBLIC", ["--name", "my_agent", ...template, "--network-mode", "PUBLIC"]],
    [
      "authorizer — customJWT",
      [
        "--name",
        "my_agent",
        ...template,
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["app"]}}',
      ],
    ],
    [
      "request-header-allowlist",
      [
        "--name",
        "my_agent",
        ...template,
        "--request-header-allowlist",
        "X-Custom-Header",
        "Authorization",
      ],
    ],
    [
      "lifecycle-configuration",
      [
        "--name",
        "my_agent",
        ...template,
        "--lifecycle-configuration",
        '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}',
      ],
    ],
    [
      "environment-variables",
      [
        "--name",
        "my_agent",
        ...template,
        "--environment-variables",
        '{"LOG_LEVEL":"debug","APP_ENV":"staging"}',
      ],
    ],
    [
      "filesystem-configurations — sessionStorage",
      [
        "--name",
        "my_agent",
        ...template,
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/data"}}]',
      ],
    ],
    [
      "filesystem-configurations — efsAccessPoint",
      [
        "--name",
        "my_agent",
        ...template,
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}}]',
      ],
    ],
    [
      "filesystem-configurations — s3FilesAccessPoint",
      [
        "--name",
        "my_agent",
        ...template,
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    ["tags", ["--name", "my_agent", ...template, "--tags", '{"team":"ml","env":"prod"}']],
    [
      "additional-policies",
      [
        "--name",
        "my_agent",
        ...template,
        "--additional-policies",
        "arn:aws:iam::123456789012:policy/MyPolicy",
      ],
    ],
    [
      "all infrastructure flags",
      ["--name", "configured_agent", ...template, ...allInfrastructureFlags],
    ],
  ])("%s — accepts flags", async (label, flags) => {
    const projectRoot = await inProject();
    await run(["add", "runtime", ...flags]);

    const name = flags[flags.indexOf("--name") + 1]!;
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
    expect(runtime).toMatchObject({ entrypoint: "main.py", ...expectedSpecByLabel[label] });
    expect(await Bun.file(join(projectRoot, "app", name, "main.py")).exists()).toBe(true);
    const buildFlagIndex = flags.indexOf("--build");
    const isContainer =
      buildFlagIndex >= 0
        ? flags[buildFlagIndex + 1] === "Container"
        : flags.includes("hello-world-python-container");
    expect(runtime.runtimeVersion).toBe(isContainer ? undefined : "PYTHON_3_14");
    expect(await Bun.file(join(projectRoot, "app", name, "Dockerfile")).exists()).toBe(isContainer);
    expect(await Bun.file(join(projectRoot, "app", name, ".dockerignore")).exists()).toBe(
      isContainer,
    );
  });

  test.each([
    ["default", [], ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"]],
    ["none", ["--memory", "none"], []],
    ["short", ["--memory", "shortTerm"], []],
    [
      "longAndShortTerm",
      ["--memory", "longAndShortTerm"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
  ])("custom strands %s memory", async (_label, memoryFlags, expectedStrategies) => {
    const projectRoot = await inProject();
    await run([
      "add",
      "runtime",
      "--name",
      "my_agent",
      "--build",
      "CodeZip",
      "--language",
      "Python",
      "--framework",
      "strands",
      "--model-provider",
      "Bedrock",
      ...memoryFlags,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const memory = spec.memories.find(
      (candidate: { name: string }) => candidate.name === "my_agentMemory",
    );

    if (memoryFlags.length > 1 && memoryFlags[1] === "none") {
      expect(memory).toBeUndefined();
      return;
    }

    expect(memory).toMatchObject({
      name: "my_agentMemory",
      eventExpiryDuration: 30,
    });
    expect(memory.strategies.map(({ type }: { type: string }) => type)).toEqual(expectedStrategies);
  });

  test.each<[string, string[], string[]]>([
    [
      "template preset defaults to long and short-term memory",
      ["--name", "my_a2a", "--template", "strands-py-a2a"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
    [
      "template preset with --memory none",
      ["--name", "my_a2a", "--template", "strands-py-a2a", "--memory", "none"],
      [],
    ],
  ])("strands-py-a2a %s", async (_label, flags, expectedStrategies) => {
    const projectRoot = await inProject();
    await run(["add", "runtime", ...flags]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const memory = (spec.memories ?? []).find(
      (candidate: { name: string }) => candidate.name === "my_a2aMemory",
    );
    const memoryDir = join(projectRoot, "app", "my_a2a", "memory", "session.py");

    if (expectedStrategies.length === 0) {
      expect(memory).toBeUndefined();
      expect(await Bun.file(memoryDir).exists()).toBe(false);
      return;
    }

    expect(memory.strategies.map(({ type }: { type: string }) => type)).toEqual(expectedStrategies);
    expect(await Bun.file(memoryDir).exists()).toBe(true);
  });

  test.each<[string, string[], string[]]>([
    [
      "template preset",
      ["--name", "my_agent", "--template", "strands-ts"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
    [
      "custom without memory",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "TypeScript",
        "--framework",
        "strands",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
      [],
    ],
    [
      "template overrides to Container",
      ["--name", "my_agent", "--template", "strands-ts", "--build", "Container"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
  ])("strands-ts %s scaffolds a TypeScript agent", async (_label, flags, expectedStrategies) => {
    const projectRoot = await inProject();
    await run(["add", "runtime", ...flags]);

    const buildFlagIndex = flags.indexOf("--build");
    const isContainer = buildFlagIndex >= 0 && flags[buildFlagIndex + 1] === "Container";

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find(
      (candidate: { name: string }) => candidate.name === "my_agent",
    );
    expect(runtime).toMatchObject({
      entrypoint: "main.js",
      ...(isContainer
        ? { build: "Container", dockerfile: "Dockerfile" }
        : { build: "CodeZip", runtimeVersion: "NODE_22" }),
    });
    expect(runtime.runtimeVersion).toBe(isContainer ? undefined : "NODE_22");
    expect(await Bun.file(join(projectRoot, "app", "my_agent", "Dockerfile")).exists()).toBe(
      isContainer,
    );
    expect(await Bun.file(join(projectRoot, "app", "my_agent", ".dockerignore")).exists()).toBe(
      isContainer,
    );

    const memory = (spec.memories ?? []).find(
      (candidate: { name: string }) => candidate.name === "my_agentMemory",
    );
    const strategies = memory?.strategies.map(({ type }: { type: string }) => type) ?? [];
    expect(strategies).toEqual(expectedStrategies);
  });

  test.each<[string, string[]]>([
    ["missing --name", ["--template", "hello-world-python"]],
    [
      "missing --build without --template",
      [
        "--name",
        "my_agent",
        "--language",
        "Python",
        "--framework",
        "none",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    [
      "--protocol cannot override the strands-python template",
      ["--name", "my_agent", "--template", "strands-python", "--protocol", "MCP"],
    ],
    [
      "TypeScript without a strands template has no resolver",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "TypeScript",
        "--framework",
        "none",
        "--model-provider",
        "Bedrock",
      ],
    ],
    [
      "strands-ts rejects short-term-only memory",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "TypeScript",
        "--framework",
        "strands",
        "--model-provider",
        "Bedrock",
        "--memory",
        "shortTerm",
      ],
    ],
    [
      "invalid JSON in --network-config",
      ["--name", "my_agent", ...template, "--network-config", "{bad}"],
    ],
    [
      "--protocol cannot override the hello-world-python template",
      ["--name", "my_agent", "--template", "hello-world-python", "--protocol", "MCP"],
    ],
    [
      "py-mcp does not support memory",
      ["--name", "my_agent", "--template", "py-mcp", "--memory", "shortTerm"],
    ],
    [
      "--protocol alone requires --framework and --language",
      ["--name", "my_agent", "--protocol", "MCP"],
    ],
    [
      "--protocol cannot override a template",
      ["--name", "my_agent", "--template", "py-mcp", "--protocol", "MCP"],
    ],
    [
      "custom MCP runtime does not support memory",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "none",
        "--protocol",
        "MCP",
        "--model-provider",
        "Bedrock",
        "--memory",
        "shortTerm",
      ],
    ],
    [
      "--memory shortTerm is not supported with --framework none",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "none",
        "--model-provider",
        "Bedrock",
        "--memory",
        "shortTerm",
      ],
    ],
    [
      "--memory longAndShortTerm is not supported with --framework none",
      [
        "--name",
        "my_agent",
        "--build",
        "CodeZip",
        "--language",
        "Python",
        "--framework",
        "none",
        "--model-provider",
        "Bedrock",
        "--memory",
        "longAndShortTerm",
      ],
    ],
    ["runtime names are limited in length", ["--name", "x".repeat(43)]],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "runtime", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each([
    ["language", "Python"],
    ["framework", "none"],
  ])("rejects --%s as a template override", async (flagName, value) => {
    await inProject();
    await expect(
      run([
        "add",
        "runtime",
        "--name",
        "my_agent",
        "--template",
        "hello-world-python",
        `--${flagName}`,
        value,
      ]),
    ).rejects.toThrow(`--${flagName} cannot override a template`);
  });

  test("rejects an incompatible API-key template override", async () => {
    const projectRoot = await inProject();
    const apiKeyPath = join(projectRoot, "api-key.txt");
    await Bun.write(apiKeyPath, "secret-key");

    await expect(
      run([
        "add",
        "runtime",
        "--name",
        "my_agent",
        "--template",
        "hello-world-python",
        "--api-key",
        `file://${apiKeyPath}`,
      ]),
    ).rejects.toThrow(/API keys are not compatible with Bedrock model providers/);
  });
});

describe("project add runtime --type import", () => {
  const metadata = {
    agentName: "SupportAgent",
    agentStatus: "PREPARED",
    agentAliasArn: "arn:aws:bedrock:us-east-1:111122223333:agent-alias/A1B2C3D4E5/TSTALIASID",
    agentAliasName: "live",
    agentAliasStatus: "PREPARED",
    foundationModel: "us.amazon.nova-lite-v1:0",
  };

  const importArgs = [
    "add",
    "runtime",
    "--name",
    "support_proxy",
    "--type",
    "import",
    "--agent-id",
    "A1B2C3D4E5",
    "--agent-alias-id",
    "TSTALIASID",
    "--region",
    "us-east-1",
  ];

  test("scaffolds a proxy runtime wrapping the described Bedrock Agent", async () => {
    const projectRoot = await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentDescriptions["A1B2C3D4E5/TSTALIASID"] = metadata;

    await run(importArgs, { core });

    expect(core.describedBedrockAgents).toEqual([
      { region: "us-east-1", agentId: "A1B2C3D4E5", agentAliasId: "TSTALIASID" },
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "support_proxy",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/support_proxy",
      runtimeVersion: "PYTHON_3_14",
      protocol: "HTTP",
      additionalPolicies: ["bedrock-agent-policy.json"],
    });

    const appDir = join(projectRoot, "app", "support_proxy");
    const main = await Bun.file(join(appDir, "main.py")).text();
    expect(main).toContain('"A1B2C3D4E5"');
    expect(main).toContain('"TSTALIASID"');
    expect(main).toContain('"us-east-1"');
    expect(main).toContain("invoke_agent");

    const policy = await Bun.file(join(appDir, "bedrock-agent-policy.json")).json();
    expect(policy.Statement[0]).toMatchObject({
      Action: "bedrock:InvokeAgent",
      Resource: metadata.agentAliasArn,
    });

    const pyproject = await Bun.file(join(appDir, "pyproject.toml")).text();
    expect(pyproject).toContain('name = "support_proxy"');
    expect(pyproject).toContain("boto3");
  });

  test("warns when the agent is not PREPARED", async () => {
    await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentDescriptions["A1B2C3D4E5/TSTALIASID"] = {
      ...metadata,
      agentStatus: "NOT_PREPARED",
    };

    const { io } = await run(importArgs, { core });
    expect(io.stderr()).toContain("not PREPARED");
  });

  test("rejects a nonexistent agent with the describe error", async () => {
    await inProject();
    await expect(run(importArgs)).rejects.toThrow(/no Bedrock Agent with id 'A1B2C3D4E5'/);
  });

  test("rejects an unsupported --region before any service call", async () => {
    await inProject();
    const core = new TestCoreClient();
    const args = [...importArgs.slice(0, -2), "--region", "eu-north-1"];
    await expect(run(args, { core })).rejects.toThrow(/not a supported Bedrock Agent region/);
    expect(core.describedBedrockAgents).toEqual([]);
  });

  test("requires --agent-id and --agent-alias-id with --type import", async () => {
    await inProject();
    await expect(
      run(["add", "runtime", "--name", "p", "--type", "import", "--region", "us-east-1"]),
    ).rejects.toThrow(/requires both --agent-id and --agent-alias-id/);
  });

  test("rejects --agent-id without --type import", async () => {
    await inProject();
    await expect(run(["add", "runtime", "--name", "p", "--agent-id", "A1"])).rejects.toThrow(
      /--agent-id and --agent-alias-id require --type import/,
    );
  });

  test("rejects scaffolding flags combined with --type import", async () => {
    await inProject();
    await expect(run([...importArgs, "--framework", "strands"])).rejects.toThrow(
      /--framework is a scaffolding flag/,
    );
    await expect(run([...importArgs, "--template", "hello-world-python"])).rejects.toThrow(
      /--template is a scaffolding flag/,
    );
  });
});
