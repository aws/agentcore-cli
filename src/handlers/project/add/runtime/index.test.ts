import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  expectError,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import type { BedrockAgentImportPlan } from "../../../../core/project/bedrockAgentImport";
import { InputValidationError } from "../../../../errors";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function run(args: string[], opts?: { core?: TestCoreClient }) {
  const io = testIO();
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", ...args]);
  return { io, core };
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

async function specOf(projectRoot: string) {
  return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
}

async function runtimeOf(projectRoot: string, name: string) {
  const spec = await specOf(projectRoot);
  return spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
}

describe("project add runtime", () => {
  test.each(["Container", "ContainerLocal"])(
    "--build-config with build %s persists it and copies the Dockerfile",
    async (build) => {
      const { projectRoot, cleanup } = await initProject();
      cleanups.push(cleanup);
      const dockerfile = join(projectRoot, "Dockerfile");
      await writeFile(dockerfile, "FROM scratch\n");
      await run([
        "add",
        "runtime",
        "--name",
        "local",
        "--language",
        "python",
        "--build-config",
        JSON.stringify({ build, dockerfile, customDockerBuildArgs: { VERSION: "v1" } }),
      ]);
      const runtime = await runtimeOf(projectRoot, "local");
      expect(runtime).toMatchObject({
        build,
        dockerfile: "Dockerfile",
        codeLocation: "app/local",
        customDockerBuildArgs: { VERSION: "v1" },
      });
      expect(runtime.runtimeVersion).toBeUndefined();
      expect(await Bun.file(join(projectRoot, "app", "local", "Dockerfile")).text()).toBe(
        "FROM scratch\n",
      );
    },
  );
  test("--build-config with buildContextPath keeps the Dockerfile in that context", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await mkdir(join(projectRoot, "docker"), { recursive: true });
    await writeFile(join(projectRoot, "docker", "Agent.Dockerfile"), "FROM scratch\n");
    await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({
        build: "ContainerLocal",
        dockerfile: "Agent.Dockerfile",
        buildContextPath: "docker",
      }),
    ]);
    expect(await runtimeOf(projectRoot, "local")).toMatchObject({
      build: "ContainerLocal",
      dockerfile: "Agent.Dockerfile",
      buildContextPath: "docker",
    });
    expect(await Bun.file(join(projectRoot, "app", "local", "Dockerfile")).exists()).toBe(false);
  });
  test("copies a Dockerfile-specific ignore file along with the Dockerfile, renamed to match", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const dockerfile = join(projectRoot, "Agent.Dockerfile");
    await writeFile(dockerfile, "FROM scratch\n");
    await writeFile(`${dockerfile}.dockerignore`, "*.log\n");
    await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({ build: "ContainerLocal", dockerfile }),
    ]);
    const appDir = join(projectRoot, "app", "local");
    expect(await Bun.file(join(appDir, "Dockerfile")).text()).toBe("FROM scratch\n");
    expect(await Bun.file(join(appDir, "Dockerfile.dockerignore")).text()).toBe("*.log\n");
  });
  test("accepts a Dockerfile-specific ignore file in an existing build context", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await mkdir(join(projectRoot, "docker"), { recursive: true });
    await writeFile(join(projectRoot, "docker", "Agent.Dockerfile"), "FROM scratch\n");
    await writeFile(join(projectRoot, "docker", "Agent.Dockerfile.dockerignore"), "*.log\n");
    await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({
        build: "ContainerLocal",
        dockerfile: "Agent.Dockerfile",
        buildContextPath: "docker",
      }),
    ]);
    expect(await runtimeOf(projectRoot, "local")).toMatchObject({ buildContextPath: "docker" });
    expect(
      await Bun.file(join(projectRoot, "app", "local", "Dockerfile.dockerignore")).exists(),
    ).toBe(false);
  });
  test("says it copied the Dockerfile and that later edits to the original are not used", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await writeFile(join(projectRoot, "Dockerfile"), "FROM scratch\n");
    const { io } = await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({ build: "ContainerLocal", dockerfile: join(projectRoot, "Dockerfile") }),
    ]);
    expect(io.stderr()).toContain(
      `copied ${join(projectRoot, "Dockerfile")} to app/local/Dockerfile; later edits to the original are not used`,
    );
  });
  test("refuses a different Dockerfile already in app/<name> and writes nothing", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await mkdir(join(projectRoot, "app", "local"), { recursive: true });
    await writeFile(join(projectRoot, "app", "local", "Dockerfile"), "FROM scratch\n");
    const other = join(projectRoot, "other.Dockerfile");
    await writeFile(other, "FROM public.ecr.aws/docker/library/python:3.12-slim\n");
    await expectError(
      run([
        "add",
        "runtime",
        "--name",
        "local",
        "--language",
        "python",
        "--build-config",
        JSON.stringify({ build: "ContainerLocal", dockerfile: other }),
      ]),
      `app/local/Dockerfile already exists and differs from ${other}`,
      InputValidationError,
    );
    expect(await Bun.file(join(projectRoot, "app", "local", "Dockerfile")).text()).toBe(
      "FROM scratch\n",
    );
    expect((await specOf(projectRoot)).runtimes ?? []).toEqual([]);
    expect((await readdir(join(projectRoot, "app", "local"))).sort()).toEqual(["Dockerfile"]);
  });
  test("accepts an identical Dockerfile already in app/<name>", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await mkdir(join(projectRoot, "app", "local"), { recursive: true });
    await writeFile(join(projectRoot, "app", "local", "Dockerfile"), "FROM scratch\n");
    await writeFile(join(projectRoot, "same.Dockerfile"), "FROM scratch\n");
    await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({ build: "ContainerLocal", dockerfile: join(projectRoot, "same.Dockerfile") }),
    ]);
    expect(await runtimeOf(projectRoot, "local")).toMatchObject({
      build: "ContainerLocal",
      dockerfile: "Dockerfile",
    });
  });
  test("accepts CodeBuild-reserved build args for ContainerLocal", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await writeFile(join(projectRoot, "Dockerfile"), "FROM scratch\n");
    await run([
      "add",
      "runtime",
      "--name",
      "local",
      "--language",
      "python",
      "--build-config",
      JSON.stringify({
        build: "ContainerLocal",
        dockerfile: join(projectRoot, "Dockerfile"),
        customDockerBuildArgs: { AWS_REGION: "us-west-2", CODEBUILD_X: "1" },
      }),
    ]);
    expect(await runtimeOf(projectRoot, "local")).toMatchObject({
      customDockerBuildArgs: { AWS_REGION: "us-west-2", CODEBUILD_X: "1" },
    });
  });
  test("without --build-config a runtime stays CodeZip", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "runtime", "--name", "plain", "--language", "python"]);
    const runtime = await runtimeOf(projectRoot, "plain");
    expect(runtime.build).toBe("CodeZip");
    expect(runtime.runtimeVersion).toBeDefined();
    expect(runtime.dockerfile).toBeUndefined();
  });
  test.each<[string, string, string]>([
    ["invalid JSON", "{bad}", "Invalid JSON for option '--build-config'"],
    ["an unknown key", '{"build":"Container","image":"x"}', "--build-config"],
    ["an unknown build", '{"build":"Local","dockerfile":"Dockerfile"}', "--build-config"],
    [
      "a reserved build argument",
      '{"build":"Container","dockerfile":"Dockerfile","customDockerBuildArgs":{"AWS_REGION":"x"}}',
      "Invalid value for option '--build-config': customDockerBuildArgs must not use keys reserved by the CodeBuild build environment",
    ],
    [
      "a container build without a Dockerfile",
      '{"build":"ContainerLocal"}',
      "Invalid value for option '--build-config': dockerfile is required",
    ],
    [
      "container settings without a container build",
      '{"dockerfile":"Dockerfile"}',
      "Invalid value for option '--build-config': dockerfile requires build Container or ContainerLocal",
    ],
    [
      "an absolute buildContextPath",
      '{"build":"ContainerLocal","buildContextPath":"/tmp/ctx","dockerfile":"Dockerfile"}',
      "Invalid value for option '--build-config': buildContextPath must be relative to the project root",
    ],
    [
      "an absolute dockerfile inside a build context",
      '{"build":"ContainerLocal","buildContextPath":"ctx","dockerfile":"/tmp/ctx/Dockerfile"}',
      "Invalid value for option '--build-config': with buildContextPath, dockerfile must be relative to that build context",
    ],
    [
      "a dockerfile escaping its build context",
      '{"build":"ContainerLocal","buildContextPath":"ctx","dockerfile":"../Dockerfile"}',
      "Invalid value for option '--build-config': with buildContextPath, dockerfile must be relative",
    ],
  ])("rejects --build-config with %s and writes nothing", async (_label, value, message) => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await writeFile(join(projectRoot, "Dockerfile"), "FROM scratch\n");
    await expectError(
      run(["add", "runtime", "--name", "local", "--language", "python", "--build-config", value]),
      message,
      InputValidationError,
    );
    expect((await specOf(projectRoot)).runtimes ?? []).toEqual([]);
  });
  test("--dockerfile is not an add runtime option", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(
      run(["add", "runtime", "--name", "local", "--language", "python", "--dockerfile", "x"]),
    ).rejects.toThrow("unknown option '--dockerfile'");
  });
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
    "--platform-version",
    "V2",
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

  test.each<[string, string[], Record<string, unknown>, RegExp, RegExp[]]>([
    [
      "python (HTTP by default)",
      ["--language", "python"],
      { entrypoint: "main.py", protocol: "HTTP", runtimeVersion: "PYTHON_3_14" },
      /POST \/invocations/,
      [/runtime-mcp-/, /runtime-a2a-/, /runtime-agui-/],
    ],
    [
      "python MCP",
      ["--language", "python", "--protocol", "MCP"],
      { entrypoint: "main.py", protocol: "MCP", runtimeVersion: "PYTHON_3_14" },
      /port \*\*8000\*\*/,
      [/runtime-http-/, /runtime-a2a-/, /runtime-agui-/],
    ],
    [
      "typescript A2A",
      ["--language", "typescript", "--protocol", "A2A"],
      { entrypoint: "main.js", protocol: "A2A", runtimeVersion: "NODE_22" },
      /agent-card\.json/,
      [/runtime-http-/, /runtime-mcp-/, /runtime-agui-/],
    ],
    [
      "typescript AGUI",
      ["--language", "typescript", "--protocol", "AGUI"],
      { entrypoint: "main.js", protocol: "AGUI", runtimeVersion: "NODE_22" },
      /RunAgentInput/,
      [/runtime-http-/, /runtime-mcp-/, /runtime-a2a-/],
    ],
  ])(
    "%s writes the runtime docs and a complete spec entry with starting values",
    async (_label, flags, expected, contract, otherContracts) => {
      const { projectRoot, cleanup } = await initProject();
      cleanups.push(cleanup);
      const { core, io } = await run(["add", "runtime", "--name", "search", ...flags]);

      const runtime = await runtimeOf(projectRoot, "search");
      expect(runtime).toEqual({
        name: "search",
        codeLocation: "app/search",
        build: "CodeZip",
        ...expected,
      });
      // No code is scaffolded and nothing is installed.
      expect(core.projectCommands).toEqual([]);
      const appDir = join(projectRoot, "app", "search");
      expect((await readdir(appDir)).sort()).toEqual(["AGENTS.md", "README.md"]);

      const readme = await Bun.file(join(appDir, "README.md")).text();
      const agents = await Bun.file(join(appDir, "AGENTS.md")).text();
      expect(readme).toMatch(contract);
      for (const other of otherContracts) expect(readme).not.toMatch(other);
      expect(readme).not.toContain("{{");
      // Discovery variables use the names the CDK app sets.
      expect(readme).toContain("`MEMORY_SEARCHMEMORY_ID`");
      expect(readme).toContain("`AGENTCORE_GATEWAY_DOCS_GATEWAY_URL`");
      expect(readme).toContain("`CREDENTIAL_OPENAI_KEY_NAME`");
      expect(readme + agents).not.toMatch(/AGENTCORE_(MEMORY|CREDENTIAL)_/);
      expect(agents).toContain("runtime `search`");
      expect(agents).toContain(
        `runtime-${String(expected.protocol).toLowerCase()}-protocol-contract.html`,
      );
      expect(readme).toContain(expected.entrypoint === "main.py" ? "main.py" : "main.ts");
      // Points at the SDK and explains how agentcore.json follows the code.
      expect(readme).toContain(
        expected.entrypoint === "main.py"
          ? "https://github.com/aws/bedrock-agentcore-sdk-python"
          : "https://github.com/aws/bedrock-agentcore-sdk-typescript",
      );
      expect(readme).toContain("## How `agentcore.json` follows your code");
      expect(readme).toContain('find the object whose `"name"` is `"search"`');
      expect(readme).toContain(`"runtimeVersion": "${expected.runtimeVersion as string}"`);
      expect(readme).toContain('"buildContextPath"');
      expect(readme).toContain('"customDockerBuildArgs"');
      if (expected.entrypoint === "main.js") {
        expect(readme).toContain("--format=esm");
        expect(readme).toContain("--packages=external");
      }
      expect(readme + agents).not.toContain("CLAUDE");

      expect(io.stderr()).toContain(
        `added runtime "search" (${flags[1] === "python" ? "Python" : "TypeScript"}, ${expected.protocol})`,
      );
      expect(io.stderr()).toContain("read app/search/README.md for requirements");
    },
  );

  test("infrastructure flags are written to the spec entry", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run([
      "add",
      "runtime",
      "--name",
      "configured_agent",
      "--language",
      "python",
      ...allInfrastructureFlags,
    ]);

    expect(await runtimeOf(projectRoot, "configured_agent")).toEqual({
      name: "configured_agent",
      codeLocation: "app/configured_agent",
      build: "CodeZip",
      runtimeVersion: "PYTHON_3_14",
      entrypoint: "main.py",
      protocol: "HTTP",
      description: "Configured runtime",
      executionRoleArn: "arn:aws:iam::123456789012:role/MyRole",
      additionalPolicies: ["arn:aws:iam::123456789012:policy/MyPolicy"],
      networkMode: "VPC",
      networkConfig: {
        subnets: ["subnet-0123456789abcdef0"],
        securityGroups: ["sg-0123456789abcdef0"],
      },
      platformVersion: "V2",
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
    });
  });

  test("an S3 bucket mount is written to the spec entry", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run([
      "add",
      "runtime",
      "--name",
      "s3_agent",
      "--language",
      "python",
      "--platform-version",
      "V2",
      "--filesystem-configurations",
      JSON.stringify([
        {
          s3BucketMount: {
            bucket: "amzn-s3-demo-bucket",
            mountPath: "/mnt/data",
            prefix: "sessions/{runtimeSessionId}/",
            s3BucketOwner: "123456789012",
            s3BucketRegion: "us-west-2",
          },
        },
      ]),
    ]);

    expect(await runtimeOf(projectRoot, "s3_agent")).toMatchSnapshot();
  });

  test("an existing folder keeps the user's files; only missing docs are added", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const appDir = join(projectRoot, "app", "search");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "main.py"), "print('mine')\n");
    await writeFile(join(appDir, "README.md"), "# my readme\n");

    const { io } = await run(["add", "runtime", "--name", "search", "--language", "python"]);

    expect(await Bun.file(join(appDir, "main.py")).text()).toBe("print('mine')\n");
    expect(await Bun.file(join(appDir, "README.md")).text()).toBe("# my readme\n");
    expect(await Bun.file(join(appDir, "AGENTS.md")).text()).toContain("runtime `search`");
    expect(await Bun.file(join(appDir, "CLAUDE.md")).exists()).toBe(false);
    expect(io.stderr()).toContain("'app/search/README.md' already exists; left unchanged");
    expect(await runtimeOf(projectRoot, "search")).toMatchObject({ codeLocation: "app/search" });
  });

  test("--json reports the added runtime", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const { io } = await run([
      "add",
      "runtime",
      "--name",
      "search",
      "--language",
      "typescript",
      "--json",
    ]);
    expect(JSON.parse(io.stdout())).toMatchObject({
      operation: "add",
      resource: { type: "runtime", name: "search" },
    });
  });

  test("a China region does not restrict a runtime whose code the user writes", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run([
      "add",
      "runtime",
      "--name",
      "cn_agent",
      "--language",
      "python",
      "--region",
      "cn-north-1",
    ]);
    expect(await runtimeOf(projectRoot, "cn_agent")).toMatchObject({ entrypoint: "main.py" });
  });

  test.each<[string, string[], string?]>([
    ["missing --name", ["--language", "python"], "required option '--name' not specified"],
    [
      "missing --language",
      ["--name", "my_agent"],
      "required option '--language <language>' not specified",
    ],
    [
      "deployed name over the 48-character service limit",
      ["--name", `r${"x".repeat(28)}`, "--language", "python"],
      `Runtime deployed name 'TestProject_default_r${"x".repeat(28)}' is 49 characters. The maximum is 48.`,
    ],
    [
      "--framework requires --agent-id",
      ["--name", "my_agent", "--language", "python", "--framework", "strands"],
      "--framework requires --agent-id",
    ],
    [
      "--agent-alias-id requires --agent-id",
      ["--name", "my_agent", "--language", "python", "--agent-alias-id", "TSTALIASID"],
      "--agent-alias-id requires --agent-id",
    ],
    [
      "invalid JSON in --network-config",
      ["--name", "my_agent", "--language", "python", "--network-config", "{bad}"],
    ],
  ])("%s", async (...[_label, flags, requiredMessage]) => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const promise = run(["add", "runtime", ...flags]);
    await expectError(promise, requiredMessage ?? /./, InputValidationError);
  });

  test.each([
    ["--template", "agent-python-minimal"],
    ["--model-provider", "anthropic"],
    ["--language", "rust"],
    ["--protocol", "GRPC"],
    ["--platform-version", "v2"],
    ["--type", "create"],
    ["--type", "import"],
  ])("rejects %s %s and writes nothing", async (flagName, value) => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(
      run(["add", "runtime", "--name", "my_agent", "--language", "python", flagName, value]),
    ).rejects.toThrow();
    expect((await specOf(projectRoot)).runtimes ?? []).toEqual([]);
    expect(await Bun.file(join(projectRoot, "app", "my_agent", "README.md")).exists()).toBe(false);
  });
});

describe("project add runtime --agent-id (Bedrock Agent import)", () => {
  const importArgs = [
    "add",
    "runtime",
    "--name",
    "support_proxy",
    "--agent-id",
    "A1B2C3D4E5",
    "--agent-alias-id",
    "TSTALIASID",
    "--region",
    "us-east-1",
  ];

  test("scaffolds owned runtime code translated from the selected agent version", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
      // Imports wire Bedrock model code; persisting the provider lets the
      // China deploy gate hard-fail if a China target is added later.
      modelProvider: "Bedrock",
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

  test("--json reports import follow-up as a structured note", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();

    const { io } = await run([...importArgs, "--json"], { core });

    expect(JSON.parse(io.stdout()).notes).toEqual([
      "Import generated 1 manual follow-up item in app/support_proxy/IMPORT_NOTES.md.",
    ]);
    expect(io.stderr()).not.toContain("IMPORT_NOTES.md");
  });

  test("supports LangGraph translation", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
      "EPISODIC",
    ]);
  });

  test("documents required permissions instead of generating policies for a caller-owned role", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(run(importArgs)).rejects.toThrow(/no Bedrock Agent with id 'A1B2C3D4E5'/);
  });

  test("rejects an unsupported --region before any service call", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const args = [...importArgs.slice(0, -2), "--region", "eu-north-1"];
    await expect(run(args, { core })).rejects.toThrow(/not a supported Bedrock Agent region/);
    expect(core.importedBedrockAgents).toEqual([]);
  });

  test("rejects the import before calling Bedrock when a target is in a China region", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "cn", account: "111122223333", region: "cn-north-1" }]),
    );
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();

    await expect(run(importArgs, { core })).rejects.toThrow(
      /Amazon Bedrock is not available in China regions/,
    );
    expect(core.importedBedrockAgents).toEqual([]);
  });

  test("rejects the import when --region is a China region even without a China target", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();

    const args = [...importArgs.slice(0, -2), "--region", "cn-north-1"];
    await expect(run(args, { core })).rejects.toThrow(
      /Amazon Bedrock is not available in China regions/,
    );
    expect(core.importedBedrockAgents).toEqual([]);
  });

  test("--agent-id alone selects the import and still needs --agent-alias-id", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    await expect(
      run(["add", "runtime", "--name", "p", "--agent-id", "A1", "--region", "us-east-1"], {
        core,
      }),
    ).rejects.toThrow(
      new InputValidationError(
        "importing a Bedrock Agent requires both --agent-id and --agent-alias-id",
      ),
    );
    expect(core.importedBedrockAgents).toEqual([]);
  });

  test("--type is no longer an option", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(run([...importArgs, "--type", "import"])).rejects.toThrow(
      "unknown option '--type'",
    );
  });

  test("accepts translation flags and rejects --language and --protocol", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    core.bedrockAgentImportPlans["A1B2C3D4E5/TSTALIASID"] = translatedImportPlan();
    await expect(run([...importArgs, "--framework", "strands"], { core })).resolves.toBeDefined();
    await expect(run([...importArgs, "--language", "python"])).rejects.toThrow(
      new InputValidationError(
        "--agent-id imports a Bedrock Agent as Python HTTP runtime code; " +
          "--language cannot be combined with it",
      ),
    );
    await expect(run([...importArgs, "--protocol", "MCP"])).rejects.toThrow(
      /--protocol cannot be combined/,
    );
    await expect(
      run([...importArgs, "--build-config", '{"build":"Container","dockerfile":"Dockerfile"}']),
    ).rejects.toThrow(/--build-config cannot be combined/);
  });
});
