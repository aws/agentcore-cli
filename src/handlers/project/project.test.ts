import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { InputValidationError } from "../../errors";

async function run(
  args: string[],
  opts?: { core?: TestCoreClient; stdin?: string; platform?: NodeJS.Platform },
) {
  const io = testIO({ stdin: opts?.stdin });
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
    platform: opts?.platform,
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

test("project status requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["status"])).rejects.toThrow(/No AgentCore project found/);
});

test("project dev requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["dev"])).rejects.toThrow(/No AgentCore project found/);
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project create", () => {
  test("--json returns the created project without human success text", async () => {
    const directory = await inTempDirectory();
    const { io } = await run([
      "create",
      "--name",
      "JsonProject",
      "--skip-install",
      "--skip-git",
      "--json",
    ]);
    const projectRoot = join(directory, "JsonProject");

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "create",
      project: { name: "JsonProject", path: projectRoot },
    });
    expect(io.stderr()).not.toContain("Created project");
    expect(io.stderr()).not.toContain("To deploy it");
  });

  test("scaffolds a harness project by default, named for the project", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.harnesses).toEqual([{ name: "MyAgent", path: "app/MyAgent" }]);
    expect(spec.runtimes).toEqual([]);

    const harness = await Bun.file(join(projectRoot, "app", "MyAgent", "harness.json")).json();
    expect(harness.model).toEqual({
      provider: "bedrock",
      modelId: "global.anthropic.claude-sonnet-4-6",
    });
    expect(harness.memory).toBeUndefined();
    expect(await Bun.file(join(projectRoot, "app", "MyAgent", "system-prompt.md")).exists()).toBe(
      true,
    );
  });

  test("refuses a project root that would exceed MAX_PATH on Windows, leaving nothing behind", async () => {
    const deep = join(await inTempDirectory(), "n".repeat(120));
    await mkdir(deep);
    process.chdir(deep);

    await expect(run(["create", "--name", "Deep"], { platform: "win32" })).rejects.toThrow(
      /too long for Windows/,
    );
    expect(await readdir(deep)).toEqual([]);

    await run(["create", "--name", "Deep", "--skip-install", "--skip-git"], { platform: "win32" });
    expect(await readdir(deep)).toEqual(["Deep"]);
  });

  test("a harness create installs CDK dependencies and git only (no uv sync)", async () => {
    const directory = await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "install", "--loglevel=http"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
  });

  test("the empty template scaffolds a project with no runtime and no harness", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyAgent",
      "--template",
      "empty",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes ?? []).toEqual([]);
    expect(spec.harnesses ?? []).toEqual([]);
    expect(existsSync(join(projectRoot, "app"))).toBe(true);
  });

  test("rejects --model-provider with the empty template", async () => {
    await inTempDirectory();
    await expect(
      run(["create", "--name", "MyAgent", "--template", "empty", "--model-provider", "anthropic"]),
    ).rejects.toThrow(/--model-provider only applies to runtime templates/);
  });

  test("rejects --model-provider without a template", async () => {
    await inTempDirectory();
    await expect(
      run(["create", "--name", "MyAgent", "--model-provider", "anthropic"]),
    ).rejects.toThrow(/--model-provider only applies to runtime templates/);
  });

  test("rejects --api-key with a template that does not support it", async () => {
    const directory = await inTempDirectory();
    await expect(
      run(
        [
          "create",
          "--name",
          "MyProject",
          "--template",
          "agent-python-minimal",
          "--api-key",
          "-",
          "--skip-install",
          "--skip-git",
        ],
        { stdin: "secret-key" },
      ),
    ).rejects.toThrow(/--api-key is not valid with the agent-python-minimal template/);
    expect(existsSync(join(directory, "MyProject"))).toBe(false);
  });

  test("rejects --model-provider with a template that does not support it", async () => {
    await inTempDirectory();
    await expect(
      run([
        "create",
        "--name",
        "MyProject",
        "--template",
        "a2a-python-strands",
        "--model-provider",
        "anthropic",
        "--skip-install",
        "--skip-git",
      ]),
    ).rejects.toThrow(/--model-provider is not valid with the a2a-python-strands template/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run([
      "create",
      "--name",
      "MyAgent",
      "--template",
      "agent-python-minimal",
    ]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "install", "--loglevel=http"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "agent_python_minimal") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Creating project tree");
    expect(io.stderr()).toContain("Installing CDK dependencies with npm");
    expect(io.stderr()).toContain("Syncing Python dependencies with uv");
    expect(io.stderr()).toContain("Initializing git repository");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
    expect(io.stderr()).toContain("Next steps:\n  cd MyAgent\n  agentcore project deploy");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    expect(core.projectCommands).toEqual([]);
  });

  test("scaffolds the strands template with longAndShortTerm memory pre-configured", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyProject");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "agent_python_strands",
      build: "CodeZip",
      codeLocation: "app/agent_python_strands",
      runtimeVersion: "PYTHON_3_14",
    });
    const memory = (spec.memories ?? [])[0];
    expect(memory).toMatchObject({ name: "agent_python_strandsMemory", eventExpiryDuration: 30 });
    expect(memory.strategies.map(({ type }: { type: string }) => type)).toEqual([
      "SEMANTIC",
      "USER_PREFERENCE",
      "SUMMARIZATION",
      "EPISODIC",
    ]);
    expect(
      await Bun.file(join(projectRoot, "app", "agent_python_strands", "main.py")).exists(),
    ).toBe(true);
  });

  test("scaffolds a keyless LiteLLM runtime with no credential", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands",
      "--model-provider",
      "lite_llm",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyProject");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toHaveLength(1);
    expect(spec.credentials ?? []).toEqual([]);
  });

  test.each<[string, string]>([
    ["anthropic", "agent_python_strandsAnthropicApiKey"],
    ["open_ai", "agent_python_strandsOpenAIApiKey"],
    ["gemini", "agent_python_strandsGeminiApiKey"],
    ["lite_llm", "agent_python_strandsLiteLLMApiKey"],
  ])("scaffolds a runtime with a %s API-key credential", async (provider, credentialName) => {
    const directory = await inTempDirectory();
    const apiKeyPath = join(directory, "api-key.txt");
    await Bun.write(apiKeyPath, "test-api-key");

    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands",
      "--model-provider",
      provider,
      "--api-key",
      `file://${apiKeyPath}`,
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyProject");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: credentialName,
    });
    const envLocal = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(envLocal).toContain("test-api-key");
  });

  test("scaffolds a Container agent from the strands -container template", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands-container",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyProject");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "agent_python_strands_container",
      build: "Container",
      codeLocation: "app/agent_python_strands_container",
      dockerfile: "Dockerfile",
    });
    expect(spec.runtimes[0].runtimeVersion).toBeUndefined();
    const runtimeRoot = join(projectRoot, "app", "agent_python_strands_container");
    expect(await Bun.file(join(runtimeRoot, "Dockerfile")).exists()).toBe(true);
    expect(await Bun.file(join(runtimeRoot, ".dockerignore")).exists()).toBe(true);
  });

  test("omits the Dockerfile from a CodeZip strands template", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands",
      "--skip-install",
      "--skip-git",
    ]);

    const runtimeRoot = join(directory, "MyProject", "app", "agent_python_strands");
    expect(await Bun.file(join(runtimeRoot, "Dockerfile")).exists()).toBe(false);
    expect(await Bun.file(join(runtimeRoot, ".dockerignore")).exists()).toBe(false);
  });

  test("generates uv.lock for a Container scaffold even with --skip-install", async () => {
    const directory = await inTempDirectory();
    const { core } = await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "agent-python-strands-container",
      "--skip-install",
      "--skip-git",
    ]);

    expect(core.projectCommands).toContainEqual({
      command: ["uv", "lock"],
      cwd: join(directory, "MyProject", "app", "agent_python_strands_container"),
    });
  });

  test("scaffolds an MCP server from the mcp-python-fastmcp template (CodeZip default)", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyProject",
      "--template",
      "mcp-python-fastmcp",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyProject");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "mcp_python_fastmcp",
      build: "CodeZip",
      protocol: "MCP",
      codeLocation: "app/mcp_python_fastmcp",
      runtimeVersion: "PYTHON_3_14",
    });
    const runtimeRoot = join(projectRoot, "app", "mcp_python_fastmcp");
    const mainPy = await Bun.file(join(runtimeRoot, "main.py")).text();
    expect(mainPy).toContain("FastMCP");
    expect(mainPy).toContain('mcp.run(transport="streamable-http")');
    expect(await Bun.file(join(runtimeRoot, "Dockerfile")).exists()).toBe(false);
    expect(spec.memories ?? []).toEqual([]);
  });

  test("scaffolds the minimal Python template", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyAgent",
      "--template",
      "agent-python-minimal",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toEqual([
      {
        name: "agent_python_minimal",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/agent_python_minimal",
        runtimeVersion: "PYTHON_3_14",
      },
    ]);
    expect(spec.memories ?? []).toEqual([]);
  });

  test("renders the LangChain template's pyproject name and no credentials", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyAgent",
      "--template",
      "agent-python-langchain",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.credentials ?? []).toEqual([]);
    const pyproject = await Bun.file(
      join(projectRoot, "app", "agent_python_langchain", "pyproject.toml"),
    ).text();
    expect(pyproject).toContain('name = "agent_python_langchain"');
  });

  test("scaffolds a TypeScript strands runtime with memory pre-configured", async () => {
    const directory = await inTempDirectory();
    await run([
      "create",
      "--name",
      "MyAgent",
      "--template",
      "agent-typescript-strands",
      "--skip-install",
      "--skip-git",
    ]);

    const projectRoot = join(directory, "MyAgent");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    // NODE_22 runtimes deploy a compiled main.js, so the spec entrypoint is main.js
    // even though the scaffolded source is main.ts.
    expect(spec.runtimes[0]).toMatchObject({
      name: "agent_typescript_strands",
      build: "CodeZip",
      entrypoint: "main.js",
      codeLocation: "app/agent_typescript_strands",
      runtimeVersion: "NODE_22",
      protocol: "HTTP",
    });
    expect(spec.memories ?? []).toHaveLength(1);
    expect(
      await Bun.file(join(projectRoot, "app", "agent_typescript_strands", "main.ts")).exists(),
    ).toBe(true);
  });

  test("rejects an invalid --name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "MyAgent", "--template", "nonsense"])).rejects.toThrow();
  });
});

describe("project add config-bundle", () => {
  const components = {
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
      configuration: {
        systemPrompt: "Help customers with their orders.",
        temperature: 0.2,
      },
    },
  };

  test("adds a configuration bundle to agentcore.json", async () => {
    const projectRoot = await inProject();
    const { io } = await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles).toEqual([
      {
        name: "OrdersConfig",
        type: "ConfigurationBundle",
        components,
        branchName: "mainline",
      },
    ]);
    expect(io.stderr()).toContain("added configuration bundle 'OrdersConfig' to 'TestProject'");
  });

  test("stores optional configuration bundle fields", async () => {
    const projectRoot = await inProject();
    const kmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--description",
      "Configuration for the order support runtime",
      "--components",
      JSON.stringify(components),
      "--branch-name",
      "production",
      "--commit-message",
      "Add the initial order support configuration",
      "--kms-key-arn",
      kmsKeyArn,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0]).toEqual({
      name: "OrdersConfig",
      type: "ConfigurationBundle",
      description: "Configuration for the order support runtime",
      components,
      branchName: "production",
      commitMessage: "Add the initial order support configuration",
      kmsKeyArn,
    });
  });

  test("reads components from a file", async () => {
    const projectRoot = await inProject();
    const componentsPath = join(projectRoot, "components.json");
    await Bun.write(componentsPath, JSON.stringify(components));

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      `file://${componentsPath}`,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0].components).toEqual(components);
  });

  test("adds no files under app", async () => {
    const projectRoot = await inProject();

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    expect(existsSync(join(projectRoot, "app", "OrdersConfig"))).toBe(false);
  });

  test("rejects a duplicate configuration bundle name", async () => {
    await inProject();
    const args = [
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ];

    await run(args);
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each([
    ["missing name", ["--components", JSON.stringify(components)]],
    ["missing components", ["--name", "OrdersConfig"]],
    ["invalid name", ["--name", "orders-config", "--components", JSON.stringify(components)]],
    ["empty components", ["--name", "OrdersConfig", "--components", "{}"]],
    [
      "component without configuration",
      ["--name", "OrdersConfig", "--components", '{"arn:component":{}}'],
    ],
    [
      "non-object component configuration",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":"not-an-object"}}',
      ],
    ],
    [
      "unexpected component field",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":{},"unexpected":true}}',
      ],
    ],
    ["malformed components", ["--name", "OrdersConfig", "--components", "{not-json"]],
    [
      "empty description",
      ["--name", "OrdersConfig", "--description", "", "--components", JSON.stringify(components)],
    ],
    [
      "branch name above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--branch-name",
        "b".repeat(129),
      ],
    ],
    [
      "commit message above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--commit-message",
        "m".repeat(501),
      ],
    ],
    [
      "invalid KMS key ARN",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--kms-key-arn",
        "not-an-arn",
      ],
    ],
  ])("rejects %s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "config-bundle", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});

describe("project add credentials", () => {
  test("--json reports the credential without exposing its secret", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "key.txt");
    await Bun.write(keyPath, "sk-secret-value\n");

    const { io } = await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key",
      `file://${keyPath}`,
      "--json",
    ]);

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "add",
      project: { name: "TestProject", path: projectRoot },
      resource: { type: "credential", name: "svc-key" },
    });
    expect(io.stdout()).not.toContain("sk-secret-value");
    expect(io.stderr()).not.toContain("added credential");
  });

  test("api-key with a file:// secret records the spec entry and stores the trailing-newline-stripped key in .env.local", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "key.txt");
    // The trailing newline mirrors `echo` and editor output; it must not reach the value.
    await Bun.write(keyPath, "sk-123\n");

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key",
      `file://${keyPath}`,
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY='sk-123'\n");
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY='sk-123'\n\n");
  });

  test("api-key without a secret writes a commented placeholder and tells the user to fill it", async () => {
    const projectRoot = await inProject();
    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("# API key for credential provider 'svc-key' (set before deploy)");
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_SVC_KEY in agentcore/.env.local before you deploy",
    );
  });

  test("api-key with an external secret reference records it in the spec and skips .env.local", async () => {
    const projectRoot = await inProject();
    const secretRef = {
      secretId: "arn:aws:secretsmanager:us-west-2:123456789012:secret:s",
      jsonKey: "apiKey",
    };

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key-secret-reference",
      JSON.stringify(secretRef),
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key", secretRef },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY");
  });

  const discoveryUrl = "https://idp.example.com/.well-known/openid-configuration";

  test("oauth custom with guided flags and a stdin secret records the spec entry and the secret", async () => {
    const projectRoot = await inProject();

    await run(
      [
        "add",
        "credentials",
        "oauth",
        "--name",
        "idp",
        "--discovery-url",
        discoveryUrl,
        "--client-id",
        "client-1",
        "--scopes",
        "openid",
        "email",
        "--client-secret",
        "-",
      ],
      { stdin: "sssh" },
    );

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        vendor: "CustomOauth2",
        clientId: "client-1",
        discoveryUrl,
        scopes: ["openid", "email"],
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_IDP_CLIENT_SECRET='sssh'");
  });

  test("oauth vendored with --provider-configuration records the config and a secret placeholder", async () => {
    const projectRoot = await inProject();

    const { io } = await run([
      "add",
      "credentials",
      "oauth",
      "--name",
      "github",
      "--vendor",
      "GithubOauth2",
      "--provider-configuration",
      '{"githubOauth2ProviderConfig":{"clientId":"client-1"}}',
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: { githubOauth2ProviderConfig: { clientId: "client-1" } },
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET in agentcore/.env.local before you deploy",
    );
  });

  test("preserves existing .env.local content and never overwrites an existing key", async () => {
    const projectRoot = await inProject();
    const envPath = join(projectRoot, "agentcore", ".env.local");
    const original = await Bun.file(envPath).text();
    await Bun.write(envPath, `${original}AGENTCORE_CREDENTIAL_SVC_KEY=user-managed\n`);

    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(envPath).text();
    expect(env).toStartWith(original);
    expect(env.match(/AGENTCORE_CREDENTIAL_SVC_KEY=/g)).toHaveLength(1);
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=user-managed");
    expect(io.stderr()).toContain("already exists");
  });

  test("creates .env.local when the project lacks one", async () => {
    const projectRoot = await inProject();
    const envPath = join(projectRoot, "agentcore", ".env.local");
    await rm(envPath);

    await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(envPath).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=\n");
  });

  test("rejects a duplicate credential name across credential types", async () => {
    await inProject();
    await run(["add", "credentials", "api-key", "--name", "dup"]);
    await expect(
      run(["add", "credentials", "oauth", "--name", "dup", "--discovery-url", discoveryUrl]),
    ).rejects.toThrow(/already exists/);
  });

  test("rejects two names that derive the same environment variable", async () => {
    await inProject();
    await run(["add", "credentials", "api-key", "--name", "svc-key"]);
    await expect(run(["add", "credentials", "api-key", "--name", "svc_key"])).rejects.toThrow(
      /same environment variable/,
    );
  });

  test("rejects different credential types that collide on one secret variable", async () => {
    await inProject();
    // OAuth 'foo' → AGENTCORE_CREDENTIAL_FOO_CLIENT_SECRET; api-key 'foo_client_secret' → the same.
    await run(["add", "credentials", "oauth", "--name", "foo", "--discovery-url", discoveryUrl]);
    await expect(
      run(["add", "credentials", "api-key", "--name", "foo_client_secret"]),
    ).rejects.toThrow(/same environment variable/);
  });

  test("rejects a name ending in a field suffix even with nothing to collide with", async () => {
    await inProject();
    // Nothing in the spec derives AGENTCORE_CREDENTIAL_SVC_CLIENT_ID, but a pre-0.29
    // OAuth credential named 'svc' would read it as its client id.
    await expect(run(["add", "credentials", "api-key", "--name", "svc-client-id"])).rejects.toThrow(
      /_CLIENT_ID/,
    );
  });

  test.each<[string, string[], RegExp]>([
    [
      "api-key: an inline secret value",
      ["api-key", "--name", "x", "--api-key", "sk-inline"],
      /file:\/\//,
    ],
    ["api-key: a multi-line secret", ["api-key", "--name", "x", "--api-key", "-"], /single-line/],
    [
      "oauth: an inline secret value",
      ["oauth", "--name", "x", "--discovery-url", discoveryUrl, "--client-secret", "sssh"],
      /file:\/\//,
    ],
    [
      "api-key: a secret combined with a secret reference",
      [
        "api-key",
        "--name",
        "x",
        "--api-key",
        "-",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey"}',
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: a secret combined with a secret reference",
      [
        "oauth",
        "--name",
        "x",
        "--discovery-url",
        discoveryUrl,
        "--client-secret",
        "-",
        "--client-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"clientSecret"}',
      ],
      /mutually exclusive/,
    ],
    ["api-key: a missing --name", ["api-key"], /--name/],
    ["oauth: a missing --name", ["oauth"], /--name/],
    [
      "oauth: a vendored provider without --provider-configuration",
      ["oauth", "--name", "x", "--vendor", "GithubOauth2"],
      /--provider-configuration/,
    ],
    [
      "oauth: a guided custom provider without --discovery-url",
      ["oauth", "--name", "x", "--client-id", "c"],
      /--discovery-url/,
    ],
    [
      "oauth: --provider-configuration combined with --scopes",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c"}}',
        "--scopes",
        "repo",
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: secret material inside --provider-configuration",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c","clientSecret":"sssh"}}',
      ],
      /secret material/,
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(["add", "credentials", ...args], { stdin: "line1\nline2" })).rejects.toThrow(
      message,
    );
  });
});

describe("project build", () => {
  async function inBuildableProject(): Promise<string> {
    const projectRoot = await inProject("MyAgent");
    // create --skip-install leaves no node_modules, which build requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    return projectRoot;
  }

  test("synthesizes the CDK app of the enclosing project", async () => {
    const projectRoot = await inBuildableProject();
    const { io, core } = await run(["build"]);

    expect(core.projectCommands).toEqual([
      {
        command: [
          "npm",
          "run",
          "cdk",
          "--",
          "synth",
          "--quiet",
          "--output",
          join(projectRoot, "agentcore", "cdk", "cdk.out"),
        ],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(io.stderr()).toContain("Built project 'MyAgent'");
  });

  test("resolves the project from a nested directory", async () => {
    const projectRoot = await inBuildableProject();
    // The default create scaffolds a harness directory named for the project.
    process.chdir(join(projectRoot, "app", "MyAgent"));

    const { core } = await run(["build"]);

    expect(core.projectCommands.map(({ cwd }) => cwd)).toEqual([
      join(projectRoot, "agentcore", "cdk"),
    ]);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("fails when the CDK dependencies have not been installed", async () => {
    const projectRoot = await inBuildableProject();
    await rm(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });

    await expect(run(["build"])).rejects.toThrow(/npm install/);
  });
});

describe("project deploy", () => {
  test("requires an AgentCore project", async () => {
    await inTempDirectory();
    await expect(run(["deploy"])).rejects.toThrow(/No AgentCore project found/);
  });

  // A bare `deploy` on a fresh project synthesizes the default target instead
  // of rejecting (covered with a stubbed backend in deploy/index.test.ts); only
  // a named target still demands configuration.
  test("rejects a project with no deployment targets for a named target", async () => {
    await inProject();
    await expect(run(["deploy", "--target", "staging"])).rejects.toThrow(
      /No deployment targets are configured/,
    );
  });
});
