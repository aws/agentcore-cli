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
import type { BedrockAgentImportPlan } from "../../../../core/project/bedrockAgentImport";

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

function translatedImportPlan(
  overrides: Partial<BedrockAgentImportPlan> = {},
): BedrockAgentImportPlan {
  return {
    framework: "strands",
    sourceAgentId: "A1B2C3D4E5",
    sourceAgentAliasId: "TSTALIASID",
    sourceAgentVersion: "7",
    files: {
      "main.py": "from strands import Agent\n# translated agent",
      "pyproject.toml": '[project]\nname = "support-proxy"\n',
      "IMPORT_NOTES.md":
        "# Bedrock Agent Import Notes\n\n" +
        "- **knowledge-base IAM:** Grant the Runtime execution role bedrock:Retrieve on: " +
        "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123.\n",
    },
    notes: [
      {
        category: "knowledge-base IAM",
        message:
          "Grant the Runtime execution role bedrock:Retrieve on: " +
          "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123.",
      },
    ],
    ...overrides,
  };
}

describe("project add runtime", () => {
  const template = ["--template", "agent-python"];

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
    "strands template overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
    },
    "mcp-python-fastmcp template preset": {
      build: "CodeZip",
      protocol: "MCP",
    },
    "mcp-python-fastmcp overrides to Container": {
      build: "Container",
      dockerfile: "Dockerfile",
      protocol: "MCP",
    },
    "custom MCP runtime": {
      build: "CodeZip",
      protocol: "MCP",
    },
    "a2a-python-strands template preset": {
      build: "CodeZip",
      protocol: "A2A",
    },
    "a2a-python-strands overrides to Container": {
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
      "agent-python-strands template preset",
      ["--name", "my_agent", "--template", "agent-python-strands"],
    ],
    [
      "template overrides to Container",
      [
        "--name",
        "my_agent",
        "--template",
        "agent-python",
        "--build",
        "Container",
        "--model-provider",
        "Bedrock",
        "--memory",
        "none",
      ],
    ],
    [
      "strands template overrides to Container",
      ["--name", "my_agent", "--template", "agent-python-strands", "--build", "Container"],
    ],
    [
      "mcp-python-fastmcp template preset",
      ["--name", "my_mcp", "--template", "mcp-python-fastmcp"],
    ],
    [
      "mcp-python-fastmcp overrides to Container",
      ["--name", "my_mcp", "--template", "mcp-python-fastmcp", "--build", "Container"],
    ],
    [
      "a2a-python-strands template preset",
      ["--name", "my_a2a", "--template", "a2a-python-strands"],
    ],
    [
      "a2a-python-strands overrides to Container",
      ["--name", "my_a2a", "--template", "a2a-python-strands", "--build", "Container"],
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
      "agent-python-strands with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_agent",
        "--template",
        "agent-python-strands",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    [
      "mcp-python-fastmcp with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_mcp",
        "--template",
        "mcp-python-fastmcp",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    [
      "a2a-python-strands with session, EFS, and S3 mounts",
      [
        "--name",
        "fs_a2a",
        "--template",
        "a2a-python-strands",
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
    const isContainer = buildFlagIndex >= 0 && flags[buildFlagIndex + 1] === "Container";
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
      ["--name", "my_a2a", "--template", "a2a-python-strands"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
    [
      "template preset with --memory none",
      ["--name", "my_a2a", "--template", "a2a-python-strands", "--memory", "none"],
      [],
    ],
  ])("a2a-python-strands %s", async (_label, flags, expectedStrategies) => {
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
      ["--name", "my_agent", "--template", "agent-typescript-strands"],
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
      ["--name", "my_agent", "--template", "agent-typescript-strands", "--build", "Container"],
      ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"],
    ],
  ])(
    "agent-typescript-strands %s scaffolds a TypeScript agent",
    async (_label, flags, expectedStrategies) => {
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
    },
  );

  test.each<[string, string[]]>([
    ["missing --name", ["--template", "agent-python"]],
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
      "--protocol cannot override the agent-python-strands template",
      ["--name", "my_agent", "--template", "agent-python-strands", "--protocol", "MCP"],
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
      "agent-typescript-strands rejects short-term-only memory",
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
      "--protocol cannot override the agent-python template",
      ["--name", "my_agent", "--template", "agent-python", "--protocol", "MCP"],
    ],
    [
      "mcp-python-fastmcp does not support memory",
      ["--name", "my_agent", "--template", "mcp-python-fastmcp", "--memory", "shortTerm"],
    ],
    [
      "--protocol alone requires --framework and --language",
      ["--name", "my_agent", "--protocol", "MCP"],
    ],
    [
      "--protocol cannot override a template",
      ["--name", "my_agent", "--template", "mcp-python-fastmcp", "--protocol", "MCP"],
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
        "agent-python",
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
        "agent-python",
        "--api-key",
        `file://${apiKeyPath}`,
      ]),
    ).rejects.toThrow(/API keys are not compatible with Bedrock model providers/);
  });
});

describe("project add runtime --type import", () => {
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

  test("scaffolds owned runtime code translated from the selected agent version", async () => {
    const projectRoot = await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();

    await run(importArgs, { core });

    expect(core.importedBedrockAgents).toEqual([
      {
        runtimeName: "support_proxy",
        region: "us-east-1",
        agentId: "A1B2C3D4E5",
        agentAliasId: "TSTALIASID",
        framework: "strands",
        memory: "none",
      },
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "support_proxy",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/support_proxy",
      runtimeVersion: "PYTHON_3_14",
      protocol: "HTTP",
    });
    expect(spec.runtimes[0].additionalPolicies).toBeUndefined();

    const appDir = join(projectRoot, "app", "support_proxy");
    const main = await Bun.file(join(appDir, "main.py")).text();
    expect(main).toContain("translated agent");
    expect(main).not.toContain("client.invoke_agent");

    const notes = await Bun.file(join(appDir, "IMPORT_NOTES.md")).text();
    expect(notes).toContain("bedrock:Retrieve");

    const pyproject = await Bun.file(join(appDir, "pyproject.toml")).text();
    expect(pyproject).toContain('name = "support-proxy"');
  });

  test("supports LangGraph translation and target memory", async () => {
    const projectRoot = await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan({
      framework: "langgraph",
    });

    await run([...importArgs, "--framework", "langgraph", "--memory", "longAndShortTerm"], {
      core,
    });

    expect(core.importedBedrockAgents[0]).toMatchObject({
      framework: "langgraph",
      memory: "longAndShortTerm",
    });
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.memories[0]).toMatchObject({
      name: "support_proxyMemory",
      strategies: expect.any(Array),
    });
  });

  test("rejects a non-HTTP protocol before importing the agent", async () => {
    await inProject();
    const core = new TestCoreClient();

    await expect(run([...importArgs, "--protocol", "MCP"], { core })).rejects.toThrow(
      /only supports HTTP/,
    );
    expect(core.importedBedrockAgents).toEqual([]);
  });

  test("documents required permissions instead of generating policies for a caller-owned role", async () => {
    const projectRoot = await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();
    const roleArn = "arn:aws:iam::111122223333:role/ExistingRuntimeRole";

    const { io } = await run([...importArgs, "--role-arn", roleArn], { core });

    expect(io.stderr()).toContain("IMPORT_NOTES.md");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({ executionRoleArn: roleArn });
    expect(spec.runtimes[0].additionalPolicies).toBeUndefined();

    const appDir = join(projectRoot, "app", "support_proxy");
    const notes = await Bun.file(join(appDir, "IMPORT_NOTES.md")).text();
    expect(notes).toContain("bedrock:Retrieve");
    expect(await Bun.file(join(appDir, "bedrock-knowledge-base-policy.json")).exists()).toBe(false);
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
    expect(core.importedBedrockAgents).toEqual([]);
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

  test("accepts translation flags and rejects incompatible scaffolding flags", async () => {
    await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();
    await expect(run([...importArgs, "--framework", "strands"], { core })).resolves.toBeDefined();
    await expect(run([...importArgs, "--template", "agent-python"])).rejects.toThrow(
      /--template cannot be combined/,
    );
    await expect(run([...importArgs, "--build", "Container"])).rejects.toThrow(
      /--build cannot be combined/,
    );
  });
});
