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
import { credentialEnvVarName } from "../../../../projectSchemas/credential";

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
  const template = ["--template", "agent-python-minimal"];

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
    "strands -container template": {
      build: "Container",
      dockerfile: "Dockerfile",
    },
    "mcp-python-fastmcp template preset": {
      build: "CodeZip",
      protocol: "MCP",
    },
    "a2a-python-strands template preset": {
      build: "CodeZip",
      protocol: "A2A",
    },
    "agui-python-strands template preset": {
      build: "CodeZip",
      protocol: "AGUI",
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

  const mounts = [
    "--network-mode",
    "VPC",
    "--network-config",
    '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
    "--filesystem-configurations",
    '[{"sessionStorage":{"mountPath":"/mnt/session"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
  ];

  test.each<[string, string[]]>([
    ["default (no template) scaffolds agent-python-minimal", ["--name", "my_agent"]],
    ["agent-python-minimal template preset", ["--name", "my_agent", ...template]],
    [
      "agent-python-strands template preset",
      ["--name", "my_agent", "--template", "agent-python-strands"],
    ],
    [
      "strands -container template",
      ["--name", "my_agent", "--template", "agent-python-strands-container"],
    ],
    [
      "mcp-python-fastmcp template preset",
      ["--name", "my_mcp", "--template", "mcp-python-fastmcp"],
    ],
    [
      "a2a-python-strands template preset",
      ["--name", "my_a2a", "--template", "a2a-python-strands"],
    ],
    [
      "agui-python-strands template preset",
      ["--name", "my_agui", "--template", "agui-python-strands"],
    ],
    [
      "agent-python-strands with session, EFS, and S3 mounts",
      ["--name", "fs_agent", "--template", "agent-python-strands", ...mounts],
    ],
    [
      "mcp-python-fastmcp with session, EFS, and S3 mounts",
      ["--name", "fs_mcp", "--template", "mcp-python-fastmcp", ...mounts],
    ],
    [
      "a2a-python-strands with session, EFS, and S3 mounts",
      ["--name", "fs_a2a", "--template", "a2a-python-strands", ...mounts],
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
    const isContainer = flags.some((flag) => flag.endsWith("-container"));
    expect(runtime.runtimeVersion).toBe(isContainer ? undefined : "PYTHON_3_14");
    expect(await Bun.file(join(projectRoot, "app", name, "Dockerfile")).exists()).toBe(isContainer);
    expect(await Bun.file(join(projectRoot, "app", name, ".dockerignore")).exists()).toBe(
      isContainer,
    );
  });

  test.each<[string, string[]]>([
    ["agent-python-strands", ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"]],
    ["a2a-python-strands", ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"]],
    ["agent-python-minimal", []],
    ["agent-python-langchain", []],
    ["agent-typescript-vercel", []],
    ["mcp-python-fastmcp", []],
    ["agui-python-strands", ["SEMANTIC", "USER_PREFERENCE", "SUMMARIZATION", "EPISODIC"]],
  ])("%s ships with its pre-configured memory", async (templateName, expectedStrategies) => {
    const projectRoot = await inProject();
    await run(["add", "runtime", "--name", "my_agent", "--template", templateName]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const memory = (spec.memories ?? []).find(
      (candidate: { name: string }) => candidate.name === "my_agentMemory",
    );

    if (expectedStrategies.length === 0) {
      expect(memory).toBeUndefined();
      return;
    }

    expect(memory).toMatchObject({ name: "my_agentMemory", eventExpiryDuration: 30 });
    expect(memory.strategies.map(({ type }: { type: string }) => type)).toEqual(expectedStrategies);
  });

  test("agent-typescript-strands scaffolds a TypeScript agent", async () => {
    const projectRoot = await inProject();
    await run(["add", "runtime", "--name", "my_agent", "--template", "agent-typescript-strands"]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find(
      (candidate: { name: string }) => candidate.name === "my_agent",
    );
    expect(runtime).toMatchObject({
      entrypoint: "main.js",
      build: "CodeZip",
      runtimeVersion: "NODE_22",
    });
    expect(await Bun.file(join(projectRoot, "app", "my_agent", "main.ts")).exists()).toBe(true);

    const memory = (spec.memories ?? []).find(
      (candidate: { name: string }) => candidate.name === "my_agentMemory",
    );
    expect(memory?.strategies.map(({ type }: { type: string }) => type)).toEqual([
      "SEMANTIC",
      "USER_PREFERENCE",
      "SUMMARIZATION",
      "EPISODIC",
    ]);
  });

  test("agent-typescript-vercel scaffolds a memory-free TypeScript runtime", async () => {
    const projectRoot = await inProject();
    await run(["add", "runtime", "--name", "my_agent", "--template", "agent-typescript-vercel"]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toContainEqual(
      expect.objectContaining({
        name: "my_agent",
        entrypoint: "main.js",
        build: "CodeZip",
        runtimeVersion: "NODE_22",
        protocol: "HTTP",
      }),
    );
    expect(spec.memories ?? []).toEqual([]);
  });

  test.each<[string, string]>([
    ["anthropic", "Anthropic"],
    ["OpenAI", "OpenAI"],
    ["gemini", "Gemini"],
  ])(
    "scaffolds agent-python-strands for --model-provider %s with an API-key credential",
    async (flagValue, provider) => {
      const projectRoot = await inProject();
      const apiKeyPath = join(projectRoot, "api-key.txt");
      await Bun.write(apiKeyPath, "test-api-key");

      await run([
        "add",
        "runtime",
        "--name",
        "my_agent",
        "--template",
        "agent-python-strands",
        "--model-provider",
        flagValue,
        "--api-key",
        `file://${apiKeyPath}`,
      ]);

      const credentialName = `my_agent${provider}ApiKey`;
      const envVarName = credentialEnvVarName(credentialName);

      const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
      expect(spec.credentials).toContainEqual({
        authorizerType: "ApiKeyCredentialProvider",
        name: credentialName,
      });

      const envLocal = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
      expect(envLocal).toContain(`${envVarName}='test-api-key'`);
    },
  );

  test.each<[string, string[]]>([
    ["missing --name", ["--template", "agent-python-minimal"]],
    [
      "--model-provider is not valid with the a2a-python-strands template",
      ["--name", "my_agent", "--template", "a2a-python-strands", "--model-provider", "Anthropic"],
    ],
    [
      "--api-key is not valid with the agent-python-minimal template",
      ["--name", "my_agent", "--template", "agent-python-minimal", "--api-key", "secret-key"],
    ],
    [
      "--model-provider is not valid with the agent-typescript-vercel template",
      [
        "--name",
        "my_agent",
        "--template",
        "agent-typescript-vercel",
        "--model-provider",
        "Anthropic",
      ],
    ],
    [
      "--model-provider without a template requires agent-python-strands",
      ["--name", "my_agent", "--model-provider", "Anthropic"],
    ],
    ["--framework requires --type import", ["--name", "my_agent", "--framework", "strands"]],
    [
      "invalid JSON in --network-config",
      ["--name", "my_agent", ...template, "--network-config", "{bad}"],
    ],
    ["runtime names are limited in length", ["--name", "x".repeat(43)]],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "runtime", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });

  test("rejects an unknown --template value", async () => {
    await inProject();
    await expect(
      run(["add", "runtime", "--name", "my_agent", "--template", "nonsense"]),
    ).rejects.toThrow();
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
        memory: "longAndShortTerm",
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

  test("supports LangGraph translation", async () => {
    const projectRoot = await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan({
      framework: "langgraph",
    });

    await run([...importArgs, "--framework", "langgraph"], { core });

    expect(core.importedBedrockAgents[0]).toMatchObject({
      framework: "langgraph",
      memory: "longAndShortTerm",
    });
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.memories).toMatchObject([{ name: "support_proxyMemory" }]);
    expect(spec.memories[0].strategies.map(({ type }: { type: string }) => type)).toEqual([
      "SEMANTIC",
      "USER_PREFERENCE",
      "SUMMARIZATION",
      "EPISODIC",
    ]);
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

  test("accepts translation flags and rejects a template", async () => {
    await inProject();
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();
    await expect(run([...importArgs, "--framework", "strands"], { core })).resolves.toBeDefined();
    await expect(run([...importArgs, "--template", "agent-python-minimal"])).rejects.toThrow(
      /--template cannot be combined/,
    );
  });
});
